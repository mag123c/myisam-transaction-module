import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { Redis } from 'ioredis';
import { SimpleTransactionManager, TransactionStep } from '../src/transaction';
import { SimpleTransactionConsumer } from '../src/transaction/simple-transaction.consumer';
import { CompensationService } from '../src/transaction/services/compensation.service';
import { stepRegistry } from '../src/transaction/step-registry';

describe('Transaction Resume 테스트', () => {
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
    stepRegistry.clear(); // Registry 초기화
  });

  describe('서버 재시작 후 중단 지점 재개 테스트', () => {
    it('2단계 완료 후 중단된 트랜잭션을 3단계부터 재시작해야 함', async () => {
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
        {
          name: '결제_처리',
          execute: () => {
            executionLog.push('결제_처리_실행');
            return Promise.resolve({ data: '결제완료' });
          },
          compensate: () => {
            executionLog.push('결제_처리_보상');
          },
        },
        {
          name: '알림_발송',
          execute: () => {
            executionLog.push('알림_발송_실행');
            return Promise.resolve({ data: '발송완료' });
          },
          compensate: () => {
            executionLog.push('알림_발송_보상');
          },
        },
        {
          name: '완료_처리',
          execute: () => {
            executionLog.push('완료_처리_실행');
            return Promise.resolve({ data: '처리완료' });
          },
          compensate: () => {
            executionLog.push('완료_처리_보상');
          },
        },
      ];

      // Registry에 등록
      for (const step of steps) {
        stepRegistry.register(step.name, step.execute, step.compensate);
      }

      // When
      const jobId = await transactionManager.execute(testUserId, steps);

      // Job 상태를 인위적으로 "2단계까지 완료"로 수정 (서버 중단 시뮬레이션)
      const job = await transactionManager.getStatus(jobId);
      if (job) {
        // BullMQ Job 데이터를 직접 수정하여 중단 상황 시뮬레이션
        const queue = (transactionManager as any).transactionQueue;
        const bullJob = await queue.getJob(jobId);

        if (bullJob) {
          const modifiedData = {
            ...bullJob.data,
            currentStepIndex: 2, // 3단계부터 시작해야 함
            steps: [
              {
                name: '사용자_검증',
                status: 'completed',
                index: 0,
                result: { data: '검증완료' },
              },
              {
                name: '데이터_저장',
                status: 'completed',
                index: 1,
                result: { data: '저장완료' },
              },
              { name: '결제_처리', status: 'pending', index: 2, result: null },
              { name: '알림_발송', status: 'pending', index: 3, result: null },
              { name: '완료_처리', status: 'pending', index: 4, result: null },
            ],
          };

          await bullJob.updateData(modifiedData);
        }
      }

      // Consumer를 수동으로 호출하여 Job 처리
      const queue = (transactionManager as any).transactionQueue;
      const bullJob = await queue.getJob(jobId);

      if (bullJob) {
        // Consumer 수동 실행
        await consumer.process(bullJob);
      }

      // Then: 3-5단계만 실행되어야 함
      expect(executionLog).toContain('결제_처리_실행');
      expect(executionLog).toContain('알림_발송_실행');
      expect(executionLog).toContain('완료_처리_실행');

      // 1-2단계는 다시 실행되지 않아야 함
      expect(
        executionLog.filter((log) => log === '사용자_검증_실행'),
      ).toHaveLength(0);
      expect(
        executionLog.filter((log) => log === '데이터_저장_실행'),
      ).toHaveLength(0);

      console.log('>>> 재개 테스트 실행 로그:', executionLog);
    }, 10000);

    it('3단계에서 실패한 트랜잭션은 완료된 1,2단계만 보상해야 함', async () => {
      // Given
      const executionLog: string[] = [];

      const steps: TransactionStep[] = [
        {
          name: '계정_생성',
          execute: () => {
            executionLog.push('계정_생성_실행');
            return Promise.resolve({ data: '계정생성완료' });
          },
          compensate: () => {
            executionLog.push('계정_생성_보상');
          },
        },
        {
          name: '권한_설정',
          execute: () => {
            executionLog.push('권한_설정_실행');
            return Promise.resolve({ data: '권한설정완료' });
          },
          compensate: () => {
            executionLog.push('권한_설정_보상');
          },
        },
        {
          name: '이메일_발송_실패',
          execute: () => {
            executionLog.push('이메일_발송_실행');
            throw new Error('이메일 발송 의도적 실패');
          },
          compensate: () => {
            executionLog.push('이메일_발송_보상');
          },
        },
      ];

      // Registry에 등록
      for (const step of steps) {
        stepRegistry.register(step.name, step.execute, step.compensate);
      }

      // When
      const jobId = await transactionManager.execute(testUserId, steps);

      // Consumer를 수동으로 호출하여 Job 처리
      const queue = (transactionManager as any).transactionQueue;
      const bullJob = await queue.getJob(jobId);

      if (bullJob) {
        try {
          await consumer.process(bullJob);
        } catch (error) {
          // 이메일 발송 실패로 인한 에러는 예상된 것
          console.log('>>> 예상된 에러 발생:', error.message);
        }
      }

      // Then: 보상 트랜잭션 검증
      expect(executionLog).toContain('계정_생성_실행');
      expect(executionLog).toContain('권한_설정_실행');
      expect(executionLog).toContain('이메일_발송_실행');

      // 실패한 이메일_발송은 보상되지 않지만, 성공한 계정_생성, 권한_설정은 보상되어야 함 (역순)
      expect(executionLog).toContain('권한_설정_보상');
      expect(executionLog).toContain('계정_생성_보상');
      expect(executionLog).not.toContain('이메일_발송_보상'); // 실패한 step은 보상 안함

      console.log('>>> 보상 트랜잭션 실행 로그:', executionLog);
    }, 10000);

    it('Job 데이터에 진행 상태가 정확히 저장되어야 함', async () => {
      // Given
      const steps: TransactionStep[] = [
        {
          name: '입력_검증',
          execute: () => Promise.resolve({ validated: true }),
          compensate: () => {},
        },
        {
          name: '데이터_처리',
          execute: () => Promise.resolve({ processed: true }),
          compensate: () => {},
        },
      ];

      // Registry에 등록
      for (const step of steps) {
        stepRegistry.register(step.name, step.execute, step.compensate);
      }

      // When
      const jobId = await transactionManager.execute(testUserId, steps);

      // 초기 상태 확인
      let jobStatus = await transactionManager.getStatus(jobId);
      expect(jobStatus?.data.currentStepIndex).toBe(0);
      expect(jobStatus?.data.steps).toHaveLength(2);
      expect(jobStatus?.data.steps[0].status).toBe('pending');
      expect(jobStatus?.data.steps[1].status).toBe('pending');

      // Consumer를 수동으로 호출하여 Job 처리
      const queue = (transactionManager as any).transactionQueue;
      const bullJob = await queue.getJob(jobId);

      if (bullJob) {
        await consumer.process(bullJob);
      }

      // Then: 최종 상태 확인
      jobStatus = await transactionManager.getStatus(jobId);
      // Job 상태는 BullMQ가 관리하므로 수동 실행 시에는 상태 업데이트가 안될 수 있음
      // 대신 Job 데이터의 실제 단계 완료 상태를 확인

      // 모든 단계가 완료 상태여야 함
      expect(jobStatus?.data.steps[0].status).toBe('completed');
      expect(jobStatus?.data.steps[1].status).toBe('completed');

      // 결과가 저장되어야 함
      expect(jobStatus?.data.steps[0].result).toEqual({ validated: true });
      expect(jobStatus?.data.steps[1].result).toEqual({ processed: true });

      console.log(
        '>>> Job 상태 추적 결과:',
        JSON.stringify(jobStatus?.data, null, 2),
      );
    }, 8000);
  });
});
