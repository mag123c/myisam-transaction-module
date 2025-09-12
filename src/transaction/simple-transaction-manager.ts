import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { stepRegistry, StepExecution } from './step-registry';
import { DistributedLockService } from './services/distributed-lock.service';
import { DLQService } from './services/dlq.service';
import { CompensationService } from './services/compensation.service';
import { TransactionStep, ResourceIdentifier } from './types/transaction.types';

/**
 * 단순한 BullMQ 기반 트랜잭션 매니저
 * MyISAM 환경에서 분산락 + 보상 패턴으로 데이터 일관성 보장
 */
@Injectable()
export class SimpleTransactionManager {
  private readonly logger = new Logger(SimpleTransactionManager.name);

  constructor(
    @InjectQueue('Transaction') private readonly transactionQueue: Queue,
    private readonly redis: Redis,
    private readonly distributedLockService?: DistributedLockService,
    private readonly dlqService?: DLQService,
    private readonly compensationService?: CompensationService,
  ) {
    // 테스트를 위한 기본값 설정
    if (!this.distributedLockService) {
      this.distributedLockService = new DistributedLockService(this.redis);
    }
    if (!this.dlqService) {
      this.dlqService = new DLQService(this.redis);
    }
    if (!this.compensationService) {
      this.compensationService = new CompensationService(this.redis);
    }
  }

  /**
   * 트랜잭션 실행
   * @param userId 사용자 ID
   * @param steps 실행할 단계들
   * @param resourceIdentifiers 리소스 식별자들 (락 키 생성용)
   * @param idempotencyKey 멱등키 (중복 요청 방지용)
   * @returns Job ID
   */
  async execute(
    userId: number,
    steps: TransactionStep[],
    resourceIdentifiers?: ResourceIdentifier[],
    idempotencyKey?: string,
  ): Promise<string> {
    // resourceIdentifiers가 없으면 기본값으로 사용자 락 사용
    const finalResourceIdentifiers = resourceIdentifiers || [
      { type: 'user', id: userId },
    ];
    // 멱등키 중복 요청 체크
    if (idempotencyKey) {
      const existingJobId = await this.redis.get(
        `idempotent:${idempotencyKey}`,
      );
      if (existingJobId) {
        this.logger.log(
          `멱등키 중복 요청 감지: ${idempotencyKey}, 기존 Job: ${existingJobId}`,
        );
        return existingJobId;
      }
    }

    const jobId = await this.transactionQueue.add(
      'process-transaction',
      {
        userId,
        steps: steps.map((s, index) => ({
          name: s.name,
          status: 'pending',
          index,
          result: null,
        })),
        currentStepIndex: 0,
        createdAt: new Date().toISOString(),
        idempotencyKey,
        resourceIdentifiers: finalResourceIdentifiers,
      },
      {
        attempts: 1, // 트랜잭션은 1회만 시도 (재시도 없음)
        removeOnComplete: 10,
        removeOnFail: 50, // Failed Job도 보관하여 DLQ와 함께 활용
      },
    );

    // Step 함수들은 이미 Registry에 등록되어 있어야 함 (서버 부팅 시 또는 사전 등록)
    // TransactionManager는 함수 등록이 아닌 Job 관리만 담당

    // 멱등키 등록 (1시간 TTL)
    if (idempotencyKey) {
      await this.redis.set(
        `idempotent:${idempotencyKey}`,
        jobId.id!,
        'EX',
        3600,
      );
    }

    this.logger.log(
      `트랜잭션 Job 생성: ${jobId.id} (userId: ${userId}, idempotencyKey: ${idempotencyKey}, resources: ${finalResourceIdentifiers.map((r) => `${r.type}:${r.id}`).join(', ')})`,
    );
    return jobId.id!;
  }

  /**
   * 트랜잭션 상태 조회
   */
  async getStatus(jobId: string) {
    const job = await this.transactionQueue.getJob(jobId);

    if (!job) {
      return null;
    }

    return {
      id: job.id,
      status: await job.getState(),
      progress: job.progress,
      processedOn: job.processedOn,
      finishedOn: job.finishedOn,
      failedReason: job.failedReason,
      data: job.data,
    };
  }

  /**
   * 분산락 획득 (분산락 서비스 위임)
   */
  async acquireLock(
    resourceIdentifiers: ResourceIdentifier[],
    jobId: string,
    ttl: number = 30,
  ): Promise<boolean> {
    return this.distributedLockService!.acquireLock(
      resourceIdentifiers,
      jobId,
      ttl,
    );
  }

  /**
   * 분산락 해제 (분산락 서비스 위임) - 소유자 검증 포함
   */
  async releaseLock(
    resourceIdentifiers: ResourceIdentifier[],
    jobId: string,
  ): Promise<void> {
    return this.distributedLockService!.releaseLock(resourceIdentifiers, jobId);
  }

  /**
   * Step 함수 조회 (Registry 기반)
   */
  getStepFunction(stepName: string): StepExecution | undefined {
    return stepRegistry.get(stepName);
  }

  /**
   * 등록된 모든 Step 함수 이름 조회
   */
  getRegisteredStepNames(): string[] {
    return stepRegistry.getRegisteredSteps();
  }

  /**
   * DLQ에 실패한 Job 추가 (웨딩 DLQ 서비스 위임)
   */
  async addToDLQ(dlqJobData: any): Promise<string> {
    return this.dlqService!.addToDLQ(dlqJobData);
  }

  /**
   * 높은 우선순위 DLQ 조회 (DLQ 서비스 위임)
   */
  async getHighPriorityDLQ(): Promise<Array<any>> {
    return this.dlqService!.getHighPriorityDLQ();
  }

  /**
   * DLQ Job 수동 처리 완료 표시 (DLQ 서비스 위임)
   */
  async markDLQAsManuallyProcessed(
    dlqId: string,
    processorNote: string,
  ): Promise<void> {
    return this.dlqService!.markAsManuallyProcessed(dlqId, processorNote);
  }

  /**
   * DLQ 통계 조회 (DLQ 서비스 위임)
   */
  async getDLQStats(): Promise<{
    totalActive: number;
    highPriority: number;
    totalProcessed: number;
    oldestFailure?: string;
  }> {
    return this.dlqService!.getStats();
  }

  /**
   * 재시도 가능한 DLQ Job들 조회 (하위 호환성)
   */
  async getDLQRetryableJobs(): Promise<
    Array<{ jobId: string; metadata: any }>
  > {
    const activeDLQ = await this.dlqService!.getAllActiveDLQ();
    return activeDLQ
      .filter((item) => item.canRetry)
      .map((item) => ({
        jobId: item.id,
        metadata: {
          originalJobId: item.originalJobId,
          failureReason: item.failureReason,
          completedBenefits: item.completedBenefits,
          canRetry: item.canRetry,
        },
      }));
  }

  /**
   * 보상 실패 통계 조회 (보상 서비스 위임)
   */
  async getCompensationFailureStats(): Promise<{
    total: number;
    retryable: number;
    nonRetryable: number;
    oldestFailure?: string;
  }> {
    return this.compensationService!.getCompensationFailureStats();
  }

  /**
   * 재시도 가능한 보상 실패들 조회 (보상 서비스 위임)
   */
  async getRetryableCompensationFailures(): Promise<
    Array<{
      key: string;
      jobId: string;
      stepName: string;
      stepResult: any;
      errorMessage: string;
      failedAt: string;
    }>
  > {
    return this.compensationService!.getRetryableCompensationFailures();
  }

  /**
   * 보상 실패 수동 재시도 (보상 서비스 위임)
   */
  async retryCompensationFailure(failureKey: string): Promise<boolean> {
    return this.compensationService!.retryCompensationFailure(failureKey);
  }

  /**
   * 만료된 보상 실패 기록들 정리 (보상 서비스 위임)
   */
  async cleanupExpiredCompensationFailures(): Promise<number> {
    return this.compensationService!.cleanupExpiredCompensationFailures();
  }
}
