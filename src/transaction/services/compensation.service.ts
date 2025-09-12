import { Injectable, Logger } from '@nestjs/common';
import { Redis } from 'ioredis';
import { Job } from 'bullmq';
import { stepRegistry } from '../step-registry';

@Injectable()
export class CompensationService {
  private readonly logger = new Logger(CompensationService.name);

  constructor(private readonly redis: Redis) {}

  /**
   * 보상 트랜잭션 실행
   */
  async executeCompensation(
    executionResults: Array<{ step: string; result: any; stepFunction: any }>,
    job: Job<any>,
  ): Promise<void> {
    this.logger.debug(
      `보상 트랜잭션 시작: ${executionResults.length}개 단계 롤백`,
    );

    for (const { step, result, stepFunction } of executionResults) {
      try {
        this.logger.debug(`보상 실행: ${step}`);

        // 실제 보상 함수 호출
        if (stepFunction?.compensate) {
          await stepFunction.compensate(result);
        }

        this.logger.debug(`보상 완료: ${step}`);
      } catch (compensationError) {
        // 보상 실패 원인에 따라 다르게 처리
        this.logger.error(`보상 실패: ${step}`, compensationError);

        // 일시적 장애인 경우 보상 실패 정보를 별도 저장 (수동 재처리용)
        if (this.isRetryableCompensationError(compensationError)) {
          await this.recordCompensationFailure({
            jobId: job.id!,
            stepName: step,
            stepResult: result,
            error: compensationError,
            retryable: true,
          });
        } else {
          // 논리적 오류는 기록만 (재시도 불필요)
          await this.recordCompensationFailure({
            jobId: job.id!,
            stepName: step,
            stepResult: result,
            error: compensationError,
            retryable: false,
          });
        }
      }
    }

    this.logger.debug('보상 트랜잭션 완료');
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

  /**
   * 보상 실패 정보 기록 (수동 재처리용)
   */
  async recordCompensationFailure(failureInfo: {
    jobId: string;
    stepName: string;
    stepResult: any;
    error: Error;
    retryable: boolean;
  }): Promise<void> {
    try {
      const key = `compensation_failure:${failureInfo.jobId}:${failureInfo.stepName}`;

      await this.redis.hset(key, {
        jobId: failureInfo.jobId,
        stepName: failureInfo.stepName,
        stepResult: JSON.stringify(failureInfo.stepResult),
        errorMessage: failureInfo.error.message,
        errorStack: failureInfo.error.stack || '',
        retryable: failureInfo.retryable.toString(),
        failedAt: new Date().toISOString(),
      });

      // 전체 보상 실패 인덱스에 추가
      await this.redis.sadd('compensation_failures:index', key);

      // TTL 설정 (7일 후 자동 삭제)
      await this.redis.expire(key, 7 * 24 * 60 * 60);

      if (failureInfo.retryable) {
        this.logger.warn(
          `재시도 가능한 보상 실패 기록: ${failureInfo.jobId}:${failureInfo.stepName}`,
        );
      } else {
        this.logger.error(
          `재시도 불가능한 보상 실패 기록: ${failureInfo.jobId}:${failureInfo.stepName}`,
        );
      }
    } catch (recordError) {
      this.logger.error('보상 실패 기록 중 오류:', recordError);
    }
  }

  /**
   * 재시도 가능한 보상 실패들 조회
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
    const failureKeys = await this.redis.smembers(
      'compensation_failures:index',
    );
    const retryableFailures: Array<{
      key: string;
      jobId: string;
      stepName: string;
      stepResult: any;
      errorMessage: string;
      failedAt: string;
    }> = [];

    for (const key of failureKeys) {
      const failure = await this.redis.hgetall(key);
      if (failure.retryable === 'true') {
        retryableFailures.push({
          key,
          jobId: failure.jobId,
          stepName: failure.stepName,
          stepResult: JSON.parse(failure.stepResult || '{}'),
          errorMessage: failure.errorMessage,
          failedAt: failure.failedAt,
        });
      }
    }

    // 실패 시간 순으로 정렬 (오래된 것 먼저)
    return retryableFailures.sort((a, b) =>
      a.failedAt.localeCompare(b.failedAt),
    );
  }

  /**
   * 보상 실패 수동 재시도
   */
  async retryCompensationFailure(failureKey: string): Promise<boolean> {
    try {
      const failure = await this.redis.hgetall(failureKey);
      if (!failure.jobId) {
        this.logger.error(`보상 실패 정보 없음: ${failureKey}`);
        return false;
      }

      if (failure.retryable !== 'true') {
        this.logger.warn(`재시도 불가능한 보상 실패: ${failureKey}`);
        return false;
      }

      // Step Registry에서 보상 함수 조회
      const stepFunction = stepRegistry.get(failure.stepName);
      if (!stepFunction?.compensate) {
        this.logger.error(`보상 함수 없음: ${failure.stepName}`);
        return false;
      }

      // 보상 함수 재실행
      const stepResult = JSON.parse(failure.stepResult || '{}');
      await stepFunction.compensate(stepResult);

      // 성공 시 기록 삭제
      await this.redis.del(failureKey);
      await this.redis.srem('compensation_failures:index', failureKey);

      this.logger.log(`보상 재시도 성공: ${failure.jobId}:${failure.stepName}`);
      return true;
    } catch (error) {
      this.logger.error(`보상 재시도 실패: ${failureKey}`, error);
      return false;
    }
  }

  /**
   * 보상 실패 통계 조회
   */
  async getCompensationFailureStats(): Promise<{
    total: number;
    retryable: number;
    nonRetryable: number;
    oldestFailure?: string;
  }> {
    const failureKeys = await this.redis.smembers(
      'compensation_failures:index',
    );
    let retryableCount = 0;
    let oldestFailure: string | undefined;

    for (const key of failureKeys) {
      const failure = await this.redis.hgetall(key);
      if (failure.retryable === 'true') {
        retryableCount++;
      }

      if (!oldestFailure || failure.failedAt < oldestFailure) {
        oldestFailure = failure.failedAt;
      }
    }

    return {
      total: failureKeys.length,
      retryable: retryableCount,
      nonRetryable: failureKeys.length - retryableCount,
      oldestFailure,
    };
  }

  /**
   * 만료된 보상 실패 기록들 정리
   */
  async cleanupExpiredCompensationFailures(): Promise<number> {
    const failureKeys = await this.redis.smembers(
      'compensation_failures:index',
    );
    let cleanedCount = 0;

    for (const key of failureKeys) {
      const exists = await this.redis.exists(key);
      if (!exists) {
        // TTL로 만료된 키는 인덱스에서 제거
        await this.redis.srem('compensation_failures:index', key);
        cleanedCount++;
      }
    }

    if (cleanedCount > 0) {
      this.logger.log(`만료된 보상 실패 기록 ${cleanedCount}개 정리 완료`);
    }

    return cleanedCount;
  }
}
