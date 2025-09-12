import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { Redis } from 'ioredis';
import { SimpleTransactionManager, TransactionStep } from '../src/transaction';
import { stepRegistry } from '../src/transaction/step-registry';

describe('SimpleTransactionManager 단위 테스트', () => {
  let module: TestingModule;
  let transactionManager: SimpleTransactionManager;
  let redis: Redis;

  const testUserId = 1;

  beforeAll(async () => {
    redis = new Redis({
      host: 'localhost',
      port: 6380,
    });

    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          envFilePath: '.env.test',
          isGlobal: true,
        }),
        BullModule.forRoot({
          connection: {
            host: 'localhost',
            port: 6380,
          },
        }),
        BullModule.registerQueue({
          name: 'Transaction',
        }),
      ],
      providers: [
        {
          provide: 'Redis',
          useValue: redis,
        },
        {
          provide: SimpleTransactionManager,
          useFactory: (queue: any, redisInstance: Redis) => {
            return new SimpleTransactionManager(queue, redisInstance);
          },
          inject: [
            { token: 'BullQueue_Transaction', optional: false },
            'Redis',
          ],
        },
      ],
    }).compile();

    transactionManager = module.get<SimpleTransactionManager>(
      SimpleTransactionManager,
    );
    await redis.flushall();
  });

  afterAll(async () => {
    await redis.flushall();
    await redis.quit();
    await module.close();
  });

  beforeEach(async () => {
    await redis.flushall();
    stepRegistry.clear(); // Registry 초기화
  });

  describe('Job 생성 테스트', () => {
    it('트랜잭션 단계가 주어지면 BullMQ Job을 생성해야 함', async () => {
      // Given
      const steps: TransactionStep[] = [
        {
          name: 'test_step',
          execute: () => Promise.resolve({ success: true }),
          compensate: () => {},
        },
      ];

      // When
      const resourceIdentifiers = [
        { type: 'user' as const, id: testUserId, action: 'test' },
      ];
      const jobId = await transactionManager.execute(
        testUserId,
        steps,
        resourceIdentifiers,
      );

      // Then
      expect(jobId).toBeDefined();
      expect(typeof jobId).toBe('string');
      expect(jobId.length).toBeGreaterThan(0);

      // Job 상태 조회 가능
      const status = await transactionManager.getStatus(jobId);
      expect(status).toBeDefined();
      expect(status?.id).toBe(jobId);
    });

    it('Step 함수들이 Registry에 저장되어야 함', async () => {
      // Given
      const steps: TransactionStep[] = [
        {
          name: 'memory_test',
          execute: () => Promise.resolve({ data: 'test' }),
          compensate: () => {},
        },
      ];

      // Registry에 등록
      for (const step of steps) {
        stepRegistry.register(step.name, step.execute, step.compensate);
      }

      // When
      const resourceIdentifiers = [
        { type: 'user' as const, id: testUserId, action: 'memory_test' },
      ];
      await transactionManager.execute(testUserId, steps, resourceIdentifiers);

      // Then: Registry에서 조회 가능해야 함
      const registeredSteps = stepRegistry.getRegisteredSteps();
      expect(registeredSteps).toContain('memory_test');

      const stepFunction = stepRegistry.get('memory_test');
      expect(stepFunction).toBeDefined();
      expect(stepFunction?.execute).toBeDefined();
    });
  });

  describe('분산락 테스트', () => {
    it('리소스별 락 획득이 정상적으로 동작해야 함', async () => {
      const testJobId = 'test_job_123';
      const resourceIdentifiers = [{ type: 'user' as const, id: testUserId }];

      // When
      const acquired = await transactionManager.acquireLock(
        resourceIdentifiers,
        testJobId,
        10,
      );

      // Then
      expect(acquired).toBe(true);

      // Redis에서 락 확인 가능
      const lockValue = await redis.get(`tx_lock:user_${testUserId}`);
      expect(lockValue).toBe(testJobId);
    });

    it('동일 리소스로 중복 락 획득은 실패해야 함', async () => {
      const firstJobId = 'first_job';
      const secondJobId = 'second_job';
      const resourceIdentifiers = [{ type: 'user' as const, id: testUserId }];

      // Given
      const firstAcquired = await transactionManager.acquireLock(
        resourceIdentifiers,
        firstJobId,
        10,
      );
      expect(firstAcquired).toBe(true);

      // When
      const secondAcquired = await transactionManager.acquireLock(
        resourceIdentifiers,
        secondJobId,
        10,
      );

      // Then
      expect(secondAcquired).toBe(false);
    });

    it('락 해제가 정상적으로 동작해야 함', async () => {
      const testJobId = 'release_test';
      const resourceIdentifiers = [{ type: 'user' as const, id: testUserId }];

      // Given
      await transactionManager.acquireLock(resourceIdentifiers, testJobId);

      // When
      await transactionManager.releaseLock(resourceIdentifiers, testJobId);

      // Then
      const lockValue = await redis.get(`tx_lock:user_${testUserId}`);
      expect(lockValue).toBeNull();

      // 락 해제 후 다시 획득
      const reacquired = await transactionManager.acquireLock(
        resourceIdentifiers,
        'new_job',
        10,
      );
      expect(reacquired).toBe(true);
    });

    it('소유자가 아닌 Job은 락을 해제할 수 없어야 함', async () => {
      const ownerJobId = 'owner_job';
      const otherJobId = 'other_job';
      const resourceIdentifiers = [{ type: 'user' as const, id: testUserId }];

      // Given: ownerJobId가 락 보유
      await transactionManager.acquireLock(resourceIdentifiers, ownerJobId);
      const lockValue = await redis.get(`tx_lock:user_${testUserId}`);
      expect(lockValue).toBe(ownerJobId);

      // When: otherJobId가 락 해제 시도
      await transactionManager.releaseLock(resourceIdentifiers, otherJobId);

      // Then: 락이 유지되어야 함
      const lockValueAfter = await redis.get(`tx_lock:user_${testUserId}`);
      expect(lockValueAfter).toBe(ownerJobId);

      // 정상적인 소유자는 락을 해제할 수 있음
      await transactionManager.releaseLock(resourceIdentifiers, ownerJobId);
      const finalLockValue = await redis.get(`tx_lock:user_${testUserId}`);
      expect(finalLockValue).toBeNull();
    });

    it('TTL 환경변수 설정이 동작해야 함', async () => {
      const testJobId = 'ttl_test';
      const resourceIdentifiers = [{ type: 'user' as const, id: testUserId }];

      // When: 기본 TTL로 락 획득 (환경변수 사용)
      const acquired = await transactionManager.acquireLock(
        resourceIdentifiers,
        testJobId,
      );

      // Then: 락 획득 성공 및 TTL 설정 확인
      expect(acquired).toBe(true);
      const ttl = await redis.ttl(`tx_lock:user_${testUserId}`);
      const expectedTTL = parseInt(process.env.TRANSACTION_LOCK_TTL_SECONDS || '30');

      expect(ttl).toBeGreaterThan(expectedTTL - 5);
      expect(ttl).toBeLessThanOrEqual(expectedTTL);
    });

    it('다른 리소스는 독립적으로 락을 획득할 수 있어야 함', async () => {
      const user1 = 1;
      const user2 = 2;
      const resource1 = [{ type: 'user' as const, id: user1 }];
      const resource2 = [{ type: 'user' as const, id: user2 }];

      // When
      const lock1 = await transactionManager.acquireLock(resource1, 'job1');
      const lock2 = await transactionManager.acquireLock(resource2, 'job2');

      // Then
      expect(lock1).toBe(true);
      expect(lock2).toBe(true);

      // Redis 확인 가능
      const lock1Value = await redis.get(`tx_lock:user_${user1}`);
      const lock2Value = await redis.get(`tx_lock:user_${user2}`);

      expect(lock1Value).toBe('job1');
      expect(lock2Value).toBe('job2');
    });
  });

  describe('멱등키 테스트', () => {
    it('동일한 멱등키로 중복 요청 시 같은 Job ID를 반환해야 함', async () => {
      // Given
      const idempotencyKey = 'test-idempotency-123';
      const resourceIdentifiers = [{ type: 'cart' as const, id: 456 }];
      const steps: TransactionStep[] = [
        {
          name: 'idempotent_step',
          execute: () => Promise.resolve({ success: true }),
          compensate: () => {},
        },
      ];

      // When
      const jobId1 = await transactionManager.execute(
        testUserId,
        steps,
        resourceIdentifiers,
        idempotencyKey,
      );
      const jobId2 = await transactionManager.execute(
        testUserId,
        steps,
        resourceIdentifiers,
        idempotencyKey,
      );

      // Then
      expect(jobId1).toBe(jobId2);

      // Redis에서 멱등키 확인
      const cachedJobId = await redis.get(`idempotent:${idempotencyKey}`);
      expect(cachedJobId).toBe(jobId1);
    });

    it('다른 멱등키는 서로 다른 Job을 생성해야 함', async () => {
      // Given
      const key1 = 'key-1';
      const key2 = 'key-2';
      const resourceIdentifiers = [{ type: 'user' as const, id: testUserId }];
      const steps: TransactionStep[] = [
        {
          name: 'different_step',
          execute: () => Promise.resolve({ data: 'test' }),
          compensate: () => {},
        },
      ];

      // When
      const jobId1 = await transactionManager.execute(
        testUserId,
        steps,
        resourceIdentifiers,
        key1,
      );
      const jobId2 = await transactionManager.execute(
        testUserId,
        steps,
        resourceIdentifiers,
        key2,
      );

      // Then
      expect(jobId1).not.toBe(jobId2);
    });
  });

  describe('Step 함수 관리 테스트', () => {
    it('Registry 관리가 정상적으로 동작해야 함', async () => {
      // Given
      const steps: TransactionStep[] = [
        {
          name: 'cleanup_test',
          execute: () => Promise.resolve({}),
          compensate: () => {},
        },
      ];

      // Registry에 등록
      for (const step of steps) {
        stepRegistry.register(step.name, step.execute, step.compensate);
      }

      // When
      const resourceIdentifiers = [
        { type: 'user' as const, id: testUserId, action: 'cleanup_test' },
      ];
      await transactionManager.execute(testUserId, steps, resourceIdentifiers);

      // Registry에서 조회 가능
      expect(stepRegistry.has('cleanup_test')).toBe(true);
      const stepFunction = stepRegistry.get('cleanup_test');
      expect(stepFunction).toBeDefined();

      // Registry 정리 가능
      stepRegistry.clear();

      // Then: 정리 후 조회 불가
      expect(stepRegistry.has('cleanup_test')).toBe(false);
      expect(stepRegistry.get('cleanup_test')).toBeUndefined();
    });
  });
});
