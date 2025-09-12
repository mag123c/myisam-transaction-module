import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { Redis } from 'ioredis';
import { SimpleTransactionManager, TransactionStep } from '../src/transaction';
import { SimpleTransactionConsumer } from '../src/transaction/simple-transaction.consumer';
import { CompensationService } from '../src/transaction/services/compensation.service';
import { stepRegistry } from '../src/transaction/step-registry';

describe('DLQ 처리 및 MyISAM 한계 테스트', () => {
  let module: TestingModule;
  let transactionManager: SimpleTransactionManager;
  let redis: Redis;
  let consumer: SimpleTransactionConsumer;

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

  describe('DLQ (Dead Letter Queue) 처리 테스트', () => {
    it('재시도 횟수 초과 시 DLQ로 이동해야 함', async () => {
      // Given
      stepRegistry.register(
        'always_fail_step',
        () => {
          throw new Error('의도적 실패');
        },
        () => {},
      );

      const steps: TransactionStep[] = [
        {
          name: 'always_fail_step',
          execute: () => Promise.resolve({}),
          compensate: () => {},
        },
      ];

      // When
      const jobId = await transactionManager.execute(testUserId, steps);

      const queue = (transactionManager as any).transactionQueue;
      const bullJob = await queue.getJob(jobId);

      if (bullJob) {
        // attemptsMade를 3으로 설정하여 재시도 완료 상태로 시뮬레이션
        Object.defineProperty(bullJob, 'attemptsMade', {
          value: 3,
          writable: true,
        });
        Object.defineProperty(bullJob, 'opts', {
          value: { attempts: 3 },
          writable: true,
        });

        try {
          await consumer.process(bullJob);
        } catch (error) {
          // Job 실패 이벤트 수동 호출
          consumer.onFailed(bullJob, error);
        }
      }

      // Then: DLQ에 추가되어야 함
      const dlqStats = await transactionManager.getDLQStats();
      expect(dlqStats.totalActive).toBe(1);
      expect(dlqStats.highPriority).toBe(0); // 일반적인 Step 실패는 재시도 불가

      console.log('>>> DLQ 이동 테스트 완료:', dlqStats);
    }, 10000);

    it('Function Registry 미등록 에러는 재시도 가능으로 분류되어야 함', async () => {
      // Given
      const steps: TransactionStep[] = [
        {
          name: 'unregistered_step',
          execute: () => Promise.resolve({}),
          compensate: () => {},
        },
      ];

      // When
      const jobId = await transactionManager.execute(testUserId, steps);
      const queue = (transactionManager as any).transactionQueue;
      const bullJob = await queue.getJob(jobId);

      if (bullJob) {
        Object.defineProperty(bullJob, 'attemptsMade', {
          value: 3,
          writable: true,
        });
        Object.defineProperty(bullJob, 'opts', {
          value: { attempts: 3 },
          writable: true,
        });

        try {
          await consumer.process(bullJob);
        } catch (error) {
          consumer.onFailed(bullJob, error);
        }
      }

      // Then: 재시도 가능으로 분류되어야 함
      const dlqStats = await transactionManager.getDLQStats();
      expect(dlqStats.totalActive).toBe(1);
      expect(dlqStats.highPriority).toBe(1); // Function Registry 에러는 재시도 가능

      const retryableJobs = await transactionManager.getDLQRetryableJobs();
      expect(retryableJobs).toHaveLength(1);
      expect(retryableJobs[0].metadata.failureReason).toContain(
        'Step function not found',
      );
    }, 10000);
  });

  describe('MyISAM 트랜잭션 한계 테스트', () => {
    it('동시 트랜잭션 처리 시 분산락으로 순차 처리되어야 함', async () => {
      // Given
      const executionOrder: string[] = [];
      const slowStepDelay = 1000; // 1초 대기

      stepRegistry.register(
        'slow_user_validation',
        async () => {
          executionOrder.push(`사용자_검증_시작_${Date.now()}`);
          await new Promise((resolve) => setTimeout(resolve, slowStepDelay));
          executionOrder.push(`사용자_검증_완료_${Date.now()}`);
          return { validated: true };
        },
        () => {},
      );

      const steps: TransactionStep[] = [
        {
          name: 'slow_user_validation',
          execute: () => Promise.resolve({}),
          compensate: () => {},
        },
      ];

      // When
      const resourceIdentifiers = [{ type: 'user' as const, id: testUserId }];

      const [jobId1, jobId2] = await Promise.all([
        transactionManager.execute(testUserId, steps, resourceIdentifiers),
        transactionManager.execute(testUserId, steps, resourceIdentifiers),
      ]);

      expect(jobId1).toBeDefined();
      expect(jobId2).toBeDefined();

      const queue = (transactionManager as any).transactionQueue;
      const [bullJob1, bullJob2] = await Promise.all([
        queue.getJob(jobId1),
        queue.getJob(jobId2),
      ]);

      const processPromises: Promise<any>[] = [];
      if (bullJob1) processPromises.push(consumer.process(bullJob1));
      if (bullJob2) processPromises.push(consumer.process(bullJob2));

      const results = await Promise.allSettled(processPromises);

      // Then
      const successCount = results.filter(
        (r) => r.status === 'fulfilled',
      ).length;
      const failureCount = results.filter(
        (r) => r.status === 'rejected',
      ).length;

      expect(successCount).toBe(1); // 하나만 성공
      expect(failureCount).toBe(1); // 하나는 락 때문에 실패

      // 실패한 것은 리소스 락 에러여야 함
      const failedResult = results.find(
        (r) => r.status === 'rejected',
      ) as PromiseRejectedResult;
      expect(failedResult.reason.message).toContain(
        '다른 트랜잭션이 진행 중입니다',
      );

      console.log('>>> MyISAM 동시성 제어 테스트 완료:', {
        successCount,
        failureCount,
        executionOrder: executionOrder.slice(0, 4),
      });
    }, 15000);

    it('서로 다른 리소스는 병렬 처리 가능해야 함', async () => {
      // Given
      const user1ExecutionLog: string[] = [];
      const user2ExecutionLog: string[] = [];

      stepRegistry.register(
        'parallel_user1_step',
        async () => {
          user1ExecutionLog.push(`사용자1_시작_${Date.now()}`);
          await new Promise((resolve) => setTimeout(resolve, 500));
          user1ExecutionLog.push(`사용자1_완료_${Date.now()}`);
          return { userId: 1, result: '처리완료' };
        },
        () => {},
      );

      stepRegistry.register(
        'parallel_user2_step',
        async () => {
          user2ExecutionLog.push(`사용자2_시작_${Date.now()}`);
          await new Promise((resolve) => setTimeout(resolve, 500));
          user2ExecutionLog.push(`사용자2_완료_${Date.now()}`);
          return { userId: 2, result: '처리완료' };
        },
        () => {},
      );

      const user1Steps: TransactionStep[] = [
        {
          name: 'parallel_user1_step',
          execute: () => Promise.resolve({}),
          compensate: () => {},
        },
      ];

      const user2Steps: TransactionStep[] = [
        {
          name: 'parallel_user2_step',
          execute: () => Promise.resolve({}),
          compensate: () => {},
        },
      ];

      // When
      const [jobId1, jobId2] = await Promise.all([
        transactionManager.execute(1, user1Steps, [{ type: 'user', id: 1 }]),
        transactionManager.execute(2, user2Steps, [{ type: 'user', id: 2 }]),
      ]);

      const queue = (transactionManager as any).transactionQueue;
      const [bullJob1, bullJob2] = await Promise.all([
        queue.getJob(jobId1),
        queue.getJob(jobId2),
      ]);

      const results = await Promise.allSettled([
        bullJob1
          ? consumer.process(bullJob1)
          : // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
            Promise.reject('Job1 not found'),
        bullJob2
          ? consumer.process(bullJob2)
          : // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
            Promise.reject('Job2 not found'),
      ]);

      // Then: 둘 다 성공해야 함 (서로 다른 리소스라서 락 충돌 없음)
      const successCount = results.filter(
        (r) => r.status === 'fulfilled',
      ).length;
      expect(successCount).toBe(2);

      expect(user1ExecutionLog).toHaveLength(2);
      expect(user2ExecutionLog).toHaveLength(2);
      expect(user1ExecutionLog[0]).toContain('사용자1_시작');
      expect(user2ExecutionLog[0]).toContain('사용자2_시작');

      console.log('>>> MyISAM 병렬 처리 테스트 완료:', {
        successCount,
        user1Log: user1ExecutionLog,
        user2Log: user2ExecutionLog,
      });
    }, 15000);

    it('트랜잭션 실패 시 보상 패턴이 정확히 동작해야 함 (MyISAM 롤백 불가 환경)', async () => {
      // Given
      const compensationLog: string[] = [];

      stepRegistry.register(
        'myisam_step1_success',
        () => {
          compensationLog.push('Step1_실행완료');
          return Promise.resolve({ data: 'step1_result' });
        },
        (result) => {
          compensationLog.push(`Step1_보상실행_${result?.data}`);
        },
      );

      stepRegistry.register(
        'myisam_step2_success',
        () => {
          compensationLog.push('Step2_실행완료');
          return Promise.resolve({ data: 'step2_result' });
        },
        (result) => {
          compensationLog.push(`Step2_보상실행_${result?.data}`);
        },
      );

      stepRegistry.register(
        'myisam_step3_fail',
        () => {
          compensationLog.push('Step3_실행시도');
          throw new Error('MyISAM 제약으로 인한 실패');
        },
        () => {
          compensationLog.push('Step3_보상실행');
        },
      );

      const steps: TransactionStep[] = [
        {
          name: 'myisam_step1_success',
          execute: () => Promise.resolve({}),
          compensate: () => {},
        },
        {
          name: 'myisam_step2_success',
          execute: () => Promise.resolve({}),
          compensate: () => {},
        },
        {
          name: 'myisam_step3_fail',
          execute: () => Promise.resolve({}),
          compensate: () => {},
        },
      ];

      // When
      const jobId = await transactionManager.execute(testUserId, steps);
      const queue = (transactionManager as any).transactionQueue;
      const bullJob = await queue.getJob(jobId);

      let thrownError: Error | undefined;
      if (bullJob) {
        try {
          await consumer.process(bullJob);
        } catch (error) {
          thrownError = error as Error;
        }
      }

      // Then: 실패하면서 보상 트랜잭션이 역순으로 실행되어야 함
      expect(thrownError).toBeDefined();
      expect(thrownError?.message).toContain('MyISAM 제약으로 인한 실패');

      expect(compensationLog).toContain('Step1_실행완료');
      expect(compensationLog).toContain('Step2_실행완료');
      expect(compensationLog).toContain('Step3_실행시도');
      expect(compensationLog).toContain('Step2_보상실행_step2_result'); // 역순으로 보상
      expect(compensationLog).toContain('Step1_보상실행_step1_result');
      expect(compensationLog).not.toContain('Step3_보상실행'); // 실패한 Step은 보상 안함

      console.log('>>> MyISAM 보상 패턴 테스트 완료:', compensationLog);
    }, 10000);
  });
});
