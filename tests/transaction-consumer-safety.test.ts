import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { Redis } from 'ioredis';
import { SimpleTransactionManager, TransactionStep } from '../src/transaction';
import { SimpleTransactionConsumer } from '../src/transaction/simple-transaction.consumer';
import { CompensationService } from '../src/transaction/services/compensation.service';
import { stepRegistry } from '../src/transaction/step-registry';

describe('트랜잭션 Consumer 안전성 테스트', () => {
  let module: TestingModule;
  let transactionManager: SimpleTransactionManager;
  let redis: Redis;
  let consumer: SimpleTransactionConsumer;

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
        {
          provide: CompensationService,
          useFactory: (redisInstance: Redis) => {
            return new CompensationService(redisInstance);
          },
          inject: ['Redis'],
        },
        SimpleTransactionConsumer,
      ],
    }).compile();

    transactionManager = module.get<SimpleTransactionManager>(
      SimpleTransactionManager,
    );
    consumer = module.get<SimpleTransactionConsumer>(SimpleTransactionConsumer);

    await redis.flushall();
  });

  afterAll(async () => {
    await redis.flushall();
    await redis.quit();
    await module.close();
  });

  beforeEach(async () => {
    await redis.flushall();
    stepRegistry.clear();
  });

  describe('Consumer 락 안전성', () => {
    it('락 획득 실패한 Consumer는 다른 Job의 락을 해제하지 않아야 함', async () => {
      const userId = 123;
      const resourceIdentifiers = [{ type: 'user' as const, id: userId }];

      // Given: Job B가 락을 먼저 보유
      const jobB = 'job_b_holder';
      await transactionManager.acquireLock(resourceIdentifiers, jobB);
      const lockValue = await redis.get(`tx_lock:user_${userId}`);
      expect(lockValue).toBe(jobB);

      // Job A 준비
      stepRegistry.register(
        'test_step',
        () => Promise.resolve({ result: 'success' }),
        () => {},
      );

      const steps: TransactionStep[] = [
        {
          name: 'test_step',
          execute: () => Promise.resolve({ result: 'success' }),
          compensate: () => {},
        },
      ];

      const jobAId = await transactionManager.execute(
        userId,
        steps,
        resourceIdentifiers,
      );

      // When: Job A Consumer 실행 (락 획득 실패 예상)
      const queue = (transactionManager as any).transactionQueue;
      const bullJobA = await queue.getJob(jobAId);

      let jobAError: Error | undefined;
      try {
        await consumer.process(bullJobA!);
      } catch (error) {
        jobAError = error as Error;
      }

      // Then: Job A는 실패하지만 Job B의 락은 유지
      expect(jobAError).toBeDefined();
      expect(jobAError?.message).toContain('다른 트랜잭션이 진행 중입니다');

      const lockValueAfter = await redis.get(`tx_lock:user_${userId}`);
      expect(lockValueAfter).toBe(jobB); // Job B 락 유지
    });

    it('성공한 Consumer는 자신의 락만 해제해야 함', async () => {
      const userId = 456;
      const resourceIdentifiers = [{ type: 'user' as const, id: userId }];

      // Given: 성공하는 Step 준비
      stepRegistry.register(
        'success_step',
        () => Promise.resolve({ result: 'completed' }),
        () => {},
      );

      const steps: TransactionStep[] = [
        {
          name: 'success_step',
          execute: () => Promise.resolve({ result: 'completed' }),
          compensate: () => {},
        },
      ];

      const jobId = await transactionManager.execute(userId, steps, resourceIdentifiers);

      // When: Consumer 실행
      const queue = (transactionManager as any).transactionQueue;
      const bullJob = await queue.getJob(jobId);

      const result = await consumer.process(bullJob!);

      // Then: 성공하고 락 해제됨
      expect(result.success).toBe(true);
      const lockValue = await redis.get(`tx_lock:user_${userId}`);
      expect(lockValue).toBeNull();
    });

    it('Job 데이터 크기가 큰 경우에도 정상 처리되어야 함', async () => {
      const userId = 789;

      // Given: 큰 결과를 생성하는 Step
      const largeData = 'x'.repeat(100 * 1024); // 100KB
      stepRegistry.register(
        'large_result_step',
        () => Promise.resolve({
          essentialData: { id: 123, status: 'completed' },
          largeLog: largeData,
        }),
        () => {},
      );

      const steps: TransactionStep[] = [
        {
          name: 'large_result_step',
          execute: () => Promise.resolve({}),
          compensate: () => {},
        },
      ];

      const jobId = await transactionManager.execute(userId, steps);

      // When: Consumer 실행
      const queue = (transactionManager as any).transactionQueue;
      const bullJob = await queue.getJob(jobId);

      const result = await consumer.process(bullJob!);

      // Then: 성공적으로 처리되고 데이터 크기 확인
      expect(result.success).toBe(true);

      const finalJob = await queue.getJob(jobId);
      const jobDataSize = JSON.stringify(finalJob?.data).length;

      // 크기 임계치 체크 (운영에서 모니터링할 지표)
      if (jobDataSize > 50 * 1024) { // 50KB 임계치
        console.warn(`Job 데이터 크기 임계치 초과: ${(jobDataSize / 1024).toFixed(2)} KB`);
        // 운영에서는 이런 로그를 Loki가 수집하여 Grafana 알림 가능
      }

      expect(jobDataSize).toBeGreaterThan(100 * 1024); // 큰 데이터 확인
    });
  });
});