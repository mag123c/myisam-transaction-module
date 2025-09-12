import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { SimpleTransactionManager } from './simple-transaction-manager';
import { CompensationService } from './services/compensation.service';
import { stepRegistry } from './step-registry';

@Processor('Transaction')
export class SimpleTransactionConsumer extends WorkerHost {
  private readonly logger = new Logger(SimpleTransactionConsumer.name);

  constructor(
    private readonly transactionManager: SimpleTransactionManager,
    private readonly compensationService: CompensationService,
  ) {
    super();
  }

  async process(job: Job<any>): Promise<any> {
    const { userId, steps, currentStepIndex, resourceIdentifiers } = job.data;
    const startTime = Date.now();
    const finalResourceIdentifiers = resourceIdentifiers || [
      { type: 'user', id: userId },
    ];

    this.logger.debug(
      `트랜잭션 시작: Job ${job.id}, User ${userId}, Step ${currentStepIndex}`,
    );

    let lockAcquired = false;

    try {
      lockAcquired = await this.transactionManager.acquireLock(
        finalResourceIdentifiers,
        job.id!,
      );

      if (!lockAcquired) {
        const resourceNames = finalResourceIdentifiers
          .map((r) => `${r.type}:${r.id}`)
          .join(', ');
        throw new Error(
          `리소스(${resourceNames})에 대한 다른 트랜잭션이 진행 중입니다`,
        );
      }

      const executionResults: Array<{
        step: string;
        result: any;
        stepFunction: any;
      }> = [];
      for (let i = 0; i < currentStepIndex; i++) {
        const step = steps[i];
        if (step.status === 'completed') {
          const stepFunction = stepRegistry.get(step.name);
          if (stepFunction) {
            executionResults.push({
              step: step.name,
              result: step.result,
              stepFunction,
            });
          }
        }
      }

      for (let i = currentStepIndex; i < steps.length; i++) {
        const step = steps[i];

        try {
          const progress = Math.floor((i / steps.length) * 100);
          await job.updateProgress(progress);
          await this.updateJobStepStatus(job, i, 'in_progress');

          this.logger.debug(
            `단계 실행: ${step.name} (${i + 1}/${steps.length})`,
          );

          const stepFunction = stepRegistry.get(step.name);

          if (!stepFunction) {
            throw new Error(`Step function not found: ${step.name}`);
          }

          const result = await stepFunction.execute();

          await this.updateJobStepStatus(job, i, 'completed', result);

          executionResults.push({ step: step.name, result, stepFunction });

          this.logger.debug(`단계 완료: ${step.name}`);
        } catch (stepError) {
          await this.updateJobStepStatus(job, i, 'failed');
          await this.compensationService.executeCompensation(
            executionResults.reverse(),
            job,
          );
          throw stepError;
        }
      }

      await job.updateProgress(100);

      const duration = Date.now() - startTime;
      this.logger.debug(`트랜잭션 완료: Job ${job.id}, ${duration}ms`);

      return {
        success: true,
        executedSteps: steps.length,
        duration,
        results: executionResults,
      };
    } catch (error) {
      this.logger.error(`트랜잭션 실패: Job ${job.id}`, error);

      await this.handleDeadLetterQueue(job, error as Error);

      throw error;
    } finally {
      if (lockAcquired) {
        await this.transactionManager.releaseLock(
          finalResourceIdentifiers,
          job.id!,
        );
      }
    }
  }

  /**
   * Job의 Step 상태 업데이트
   */
  private async updateJobStepStatus(
    job: Job<any>,
    stepIndex: number,
    status: 'pending' | 'in_progress' | 'completed' | 'failed',
    result?: any,
  ): Promise<void> {
    const jobData = job.data;

    // 현재 단계 상태 업데이트
    jobData.steps[stepIndex].status = status;
    if (result !== undefined) {
      jobData.steps[stepIndex].result = result;
    }

    // 진행 중이거나 완료된 경우 currentStepIndex 업데이트
    if (status === 'in_progress' || status === 'completed') {
      jobData.currentStepIndex = Math.max(jobData.currentStepIndex, stepIndex);
    }

    // 완료된 경우 다음 단계로 진행
    if (status === 'completed' && stepIndex < jobData.steps.length - 1) {
      jobData.currentStepIndex = stepIndex + 1;
    }

    // Job 데이터 업데이트 (BullMQ에서 지원하는 방식)
    await job.updateData(jobData);
  }

  @OnWorkerEvent('completed')
  onCompleted(job: Job, result: any) {
    this.logger.log(`Job 완료: ${job.id} ${result}`);
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job, error: Error) {
    this.logger.error(`Job 실패: ${job.id}`, error);
    // DLQ 처리는 이미 process 메서드에서 처리되므로 여기서는 로깅만 함
  }

  /**
   * DLQ(Dead Letter Queue) 처리
   * 실패한 트랜잭션을 비즈니스 메타데이터와 함께 DLQ에 저장
   */
  private async handleDeadLetterQueue(
    job: Job,
    finalError: Error,
  ): Promise<void> {
    try {
      this.logger.warn(
        `트랜잭션 Job ${job.id}을 DLQ로 이동 - 실패 단계: ${job.data.currentStepIndex}`,
      );

      // 완료된 혜택들 추출
      const completedBenefits = job.data.steps
        .filter(
          (step: any, index: number) =>
            index < job.data.currentStepIndex && step.status === 'completed',
        )
        .map((step: any) => step.name);

      // DLQ 데이터 구성
      const dlqData = {
        originalJobId: job.id,
        originalJobData: job.data,
        failureReason: finalError.message,
        failureStack: finalError.stack,
        finalFailedAt: new Date().toISOString(),

        // 비즈니스 메타데이터
        completedBenefits,
        failedStep:
          job.data.steps[job.data.currentStepIndex]?.name || 'Unknown',
        customerInfo: {
          userId: job.data.userId,
        },
        manualActionRequired: `CS팀 검토 필요: ${finalError.message}`,
        canRetry: this.isDLQRetryable(finalError),
        priority: this.isDLQRetryable(finalError) ? 'high' : 'normal',
        businessContext: {
          stepCount: job.data.steps.length,
          failedStepIndex: job.data.currentStepIndex,
        },
      };

      await this.transactionManager.addToDLQ(dlqData);

      this.logger.warn(
        `DLQ 추가 완료: Job ${job.id} (완료된 작업: ${completedBenefits.join(', ')})`,
      );
    } catch (dlqError) {
      this.logger.fatal(`DLQ 처리 실패: Job ${job.id}`, dlqError);
    }
  }

  /**
   * DLQ에서 재시도 가능한 에러인지 판단
   */
  private isDLQRetryable(error: Error): boolean {
    // 재시도 가능한 에러들
    const retryableErrors = [
      'ECONNREFUSED', // 네트워크 연결 실패
      'ETIMEDOUT', // 타임아웃
      'Step function not found', // Function Registry 미등록
      'Redis connection failed', // Redis 연결 실패
      'Database temporarily unavailable', // 데이터베이스 일시 장애
      'External API timeout', // 외부 API 장애
    ];

    // 재시도 불가능한 에러들 (비즈니스 로직 에러)
    const nonRetryableErrors = [
      'Duplicate', // 중복 데이터
      'Insufficient', // 리소스 부족
      'already', // 이미 처리된 경우
      'Invalid', // 잘못된 데이터
      'Permission denied', // 권한 박탈
    ];

    // 명시적으로 재시도 불가능한 에러 확인
    const isNonRetryable = nonRetryableErrors.some((nonRetryable) =>
      error.message.toLowerCase().includes(nonRetryable.toLowerCase()),
    );

    if (isNonRetryable) return false;

    // 재시도 가능한 에러 확인
    return retryableErrors.some(
      (retryable) =>
        error.message.includes(retryable) || error.name.includes(retryable),
    );
  }

  /**
   * 보상 트랜잭션에서 재시도 가능한 에러인지 판단
   */
  private isRetryableCompensationError(error: Error): boolean {
    const retryableCompensationErrors = [
      'ECONNREFUSED', // 네트워크 연결 실패
      'ETIMEDOUT', // 타임아웃
      'Lock wait timeout', // 데이터베이스 락 타임아웃
      'Connection lost', // 연결 끊김
      'Server temporarily unavailable', // 서버 일시 장애
      'Redis connection failed', // Redis 연결 실패
    ];

    const nonRetryableErrors = [
      'not found', // 이미 삭제된 데이터
      'Invalid parameter', // 잘못된 매개변수
      'Permission denied', // 권한 없음
      'Constraint violation', // 제약조건 위반
    ];

    // 명시적으로 재시도 불가능한 에러 확인
    const isNonRetryable = nonRetryableErrors.some((nonRetryable) =>
      error.message.toLowerCase().includes(nonRetryable.toLowerCase()),
    );

    if (isNonRetryable) return false;

    // 재시도 가능한 에러 확인
    return retryableCompensationErrors.some(
      (retryable) =>
        error.message.includes(retryable) || error.name.includes(retryable),
    );
  }

  @OnWorkerEvent('progress')
  onProgress(job: Job, progress: number) {
    this.logger.debug(`Job 진행률: ${job.id} - ${progress}% ${job.data}`);
  }
}
