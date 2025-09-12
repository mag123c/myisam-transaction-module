import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { Redis } from 'ioredis';
import { SimpleTransactionManager, TransactionStep } from '../src/transaction';
import { SimpleTransactionConsumer } from '../src/transaction/simple-transaction.consumer';
import { CompensationService } from '../src/transaction/services/compensation.service';
import { stepRegistry } from '../src/transaction/step-registry';

describe('Function Registry 패턴 테스트', () => {
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
    // Registry 초기화
    stepRegistry.clear();
  });

  describe('Function Registry 기본 기능 테스트', () => {
    it('Step 함수들이 Registry에 정상적으로 등록되어야 함', async () => {
      // Given
      const executionLog: string[] = [];
      const steps: TransactionStep[] = [
        {
          name: '사용자_검증',
          execute: () => {
            executionLog.push('사용자_검증_실행');
            return Promise.resolve({ data: '검증완료' });
          },
          compensate: () => {
            executionLog.push('사용자_검증_보상');
          },
        },
        {
          name: '데이터_저장',
          execute: () => {
            executionLog.push('데이터_저장_실행');
            return Promise.resolve({ data: '저장완료' });
          },
          compensate: () => {
            executionLog.push('데이터_저장_보상');
          },
        },
      ];

      // 수동으로 Registry에 등록 (이제 TransactionManager는 등록하지 않음)
      for (const step of steps) {
        stepRegistry.register(step.name, step.execute, step.compensate);
      }

      // When
      const resourceIdentifiers = [
        { type: 'user' as const, id: testUserId, action: 'registry_test' },
      ];

      await transactionManager.execute(testUserId, steps, resourceIdentifiers);

      // Then: Registry에 등록되어야 함 (수동으로 등록했으므로 존재해야 함)
      const registeredSteps = stepRegistry.getRegisteredSteps();
      expect(registeredSteps).toContain('사용자_검증');
      expect(registeredSteps).toContain('데이터_저장');

      // Registry에서 함수들을 조회할 수 있어야 함
      const userVerifyStep = stepRegistry.get('사용자_검증');
      const dataSaveStep = stepRegistry.get('데이터_저장');

      expect(userVerifyStep).toBeDefined();
      expect(dataSaveStep).toBeDefined();

      // 함수들이 실제로 실행 가능해야 함
      const result1 = await userVerifyStep?.execute();
      const result2 = await dataSaveStep?.execute();

      expect(result1).toEqual({ data: '검증완료' });
      expect(result2).toEqual({ data: '저장완료' });
      expect(executionLog).toContain('사용자_검증_실행');
      expect(executionLog).toContain('데이터_저장_실행');
    }, 8000);

    it('동일한 이름의 Step은 마지막에 등록된 것으로 덮어써져야 함', async () => {
      // Given
      const executionLog: string[] = [];

      // 첫 번째 등록
      stepRegistry.register(
        '중복_테스트',
        () => {
          executionLog.push('첫번째_실행');
          return Promise.resolve({ version: 1 });
        },
        () => {},
      );

      // 두 번째 등록 (덮어쓰기)
      stepRegistry.register(
        '중복_테스트',
        () => {
          executionLog.push('두번째_실행');
          return Promise.resolve({ version: 2 });
        },
        () => {},
      );

      // When
      const stepFunction = stepRegistry.get('중복_테스트');
      const result = await stepFunction?.execute();

      // Then: 마지막에 등록된 함수가 실행되어야 함
      expect(result).toEqual({ version: 2 });
      expect(executionLog).toContain('두번째_실행');
      expect(executionLog).not.toContain('첫번째_실행');
    });

    it('Registry에서 존재하지 않는 Step 조회 시 undefined를 반환해야 함', () => {
      // When
      const nonExistentStep = stepRegistry.get('존재하지_않는_Step');

      // Then
      expect(nonExistentStep).toBeUndefined();
    });
  });

  describe('서버 재시작 시뮬레이션 테스트', () => {
    it('Registry에 Step이 등록된 후 Consumer가 정상적으로 실행해야 함', async () => {
      // Given: Step 함수들 사전 등록 (서버 부팅 시 시뮬레이션)
      const executionLog: string[] = [];

      stepRegistry.register(
        '부팅시_등록_Step1',
        () => {
          executionLog.push('Step1_실행');
          return Promise.resolve({ data: 'step1완료' });
        },
        () => {
          executionLog.push('Step1_보상');
        },
      );

      stepRegistry.register(
        '부팅시_등록_Step2',
        () => {
          executionLog.push('Step2_실행');
          return Promise.resolve({ data: 'step2완료' });
        },
        () => {
          executionLog.push('Step2_보상');
        },
      );

      // TransactionStep 배열 생성 (execute, compensate는 실제로 사용되지 않음)
      const steps: TransactionStep[] = [
        {
          name: '부팅시_등록_Step1',
          execute: () => Promise.resolve({}), // 더미 함수
          compensate: () => {}, // 더미 함수
        },
        {
          name: '부팅시_등록_Step2',
          execute: () => Promise.resolve({}), // 더미 함수
          compensate: () => {}, // 더미 함수
        },
      ];

      // When: Job 생성 및 Consumer 실행
      const resourceIdentifiers = [
        { type: 'user' as const, id: testUserId, action: 'restart_test' },
      ];
      const jobId = await transactionManager.execute(
        testUserId,
        steps,
        resourceIdentifiers,
      );

      const queue = (transactionManager as any).transactionQueue;
      const bullJob = await queue.getJob(jobId);

      if (bullJob) {
        await consumer.process(bullJob);
      }

      // Then: Registry에서 함수를 찾아서 실행했어야 함
      expect(executionLog).toContain('Step1_실행');
      expect(executionLog).toContain('Step2_실행');
    }, 10000);

    it('Step 함수가 Registry에 없으면 에러가 발생해야 함', async () => {
      // Given: Registry에 등록하지 않은 Step
      const steps: TransactionStep[] = [
        {
          name: '등록되지_않은_Step',
          execute: () => Promise.resolve({}),
          compensate: () => {},
        },
      ];

      // When
      const resourceIdentifiers = [
        { type: 'user' as const, id: testUserId, action: 'error_test' },
      ];
      const jobId = await transactionManager.execute(
        testUserId,
        steps,
        resourceIdentifiers,
      );

      const queue = (transactionManager as any).transactionQueue;
      const bullJob = await queue.getJob(jobId);

      let thrownError: Error | undefined;

      try {
        if (bullJob) {
          await consumer.process(bullJob);
        }
      } catch (error) {
        thrownError = error as Error;
      }

      // Then: Step function not found 에러가 발생해야 함
      expect(thrownError).toBeDefined();
      expect(thrownError?.message).toContain('Step function not found');
      expect(thrownError?.message).toContain('등록되지_않은_Step');
    }, 8000);
  });
});
