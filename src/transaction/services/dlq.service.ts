import { Injectable, Logger } from '@nestjs/common';
import { Redis } from 'ioredis';
import { DLQData, DLQStats, CustomerInfo } from '../types/transaction.types';

@Injectable()
export class DLQService {
  private readonly logger = new Logger(DLQService.name);

  constructor(private readonly redis: Redis) {}

  /**
   * DLQ에 실패한 트랜잭션 정보 추가
   */
  async addToDLQ(dlqJobData: {
    originalJobId: string;
    originalJobData: any;
    failureReason: string;
    failureStack?: string;
    finalFailedAt: string;
    completedBenefits: string[];
    failedStep: string;
    customerInfo: CustomerInfo;
    manualActionRequired: string;
    priority: 'high' | 'normal';
    canRetry: boolean;
    businessContext?: Record<string, any>;
  }): Promise<string> {
    const dlqId = `dlq_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    // DLQ 데이터 구성
    const dlqData: Omit<DLQData, 'id'> = {
      originalJobId: dlqJobData.originalJobId,
      originalJobData: dlqJobData.originalJobData,
      failureReason: dlqJobData.failureReason,
      failureStack: dlqJobData.failureStack || '',
      failedAt: dlqJobData.finalFailedAt,

      // 비즈니스 메타데이터
      completedBenefits: dlqJobData.completedBenefits,
      failedStep: dlqJobData.failedStep,
      customerInfo: dlqJobData.customerInfo,
      manualActionRequired: dlqJobData.manualActionRequired,
      priority: dlqJobData.priority,
      canRetry: dlqJobData.canRetry,
      businessContext: dlqJobData.businessContext || {},
    };

    // DLQ 데이터 Redis에 저장
    await this.redis.hset(`dlq:${dlqId}`, {
      ...dlqData,
      id: dlqId,
      originalJobData: JSON.stringify(dlqData.originalJobData),
      completedBenefits: JSON.stringify(dlqData.completedBenefits),
      customerInfo: JSON.stringify(dlqData.customerInfo),
      businessContext: JSON.stringify(dlqData.businessContext || {}),
    });

    // DLQ 인덱스에 추가
    await this.redis.sadd('dlq:job_ids', dlqId);

    // 우선순위별 인덱스 추가
    if (dlqData.priority === 'high') {
      await this.redis.sadd('dlq:high_priority', dlqId);
    }

    this.logger.warn(
      `DLQ 격리 저장: ${dlqId} (원본: ${dlqJobData.originalJobId}, 우선순위: ${dlqData.priority})`,
    );
    return dlqId;
  }

  /**
   * 높은 우선순위 DLQ 조회
   */
  async getHighPriorityDLQ(): Promise<DLQData[]> {
    const highPriorityIds = await this.redis.smembers('dlq:high_priority');
    const dlqItems: DLQData[] = [];

    for (const dlqId of highPriorityIds) {
      const dlqData = await this.redis.hgetall(`dlq:${dlqId}`);
      if (Object.keys(dlqData).length > 0) {
        dlqItems.push({
          ...dlqData,
          completedBenefits: JSON.parse(dlqData.completedBenefits || '[]'),
          customerInfo: JSON.parse(dlqData.customerInfo || '{}'),
          originalJobData: JSON.parse(dlqData.originalJobData || '{}'),
          businessContext: JSON.parse(dlqData.businessContext || '{}'),
        } as DLQData);
      }
    }

    return dlqItems.sort(
      (a, b) => new Date(a.failedAt).getTime() - new Date(b.failedAt).getTime(),
    );
  }

  /**
   * 모든 활성 DLQ 조회
   */
  async getAllActiveDLQ(): Promise<DLQData[]> {
    const activeIds = await this.redis.smembers('dlq:job_ids');
    const dlqItems: DLQData[] = [];

    for (const dlqId of activeIds) {
      const dlqData = await this.redis.hgetall(`dlq:${dlqId}`);
      if (Object.keys(dlqData).length > 0) {
        dlqItems.push({
          ...dlqData,
          completedBenefits: JSON.parse(dlqData.completedBenefits || '[]'),
          customerInfo: JSON.parse(dlqData.customerInfo || '{}'),
          originalJobData: JSON.parse(dlqData.originalJobData || '{}'),
          businessContext: JSON.parse(dlqData.businessContext || '{}'),
        } as DLQData);
      }
    }

    return dlqItems.sort(
      (a, b) => new Date(a.failedAt).getTime() - new Date(b.failedAt).getTime(),
    );
  }

  /**
   * DLQ Job 수동 처리 완료 표시
   */
  async markAsManuallyProcessed(
    dlqId: string,
    processorNote: string,
  ): Promise<void> {
    await this.redis.hset(`dlq:${dlqId}`, {
      manuallyProcessed: 'true',
      processorNote,
      processedAt: new Date().toISOString(),
    });

    // 처리된 항목은 active 인덱스에서 제거
    await this.redis.srem('dlq:job_ids', dlqId);
    await this.redis.srem('dlq:high_priority', dlqId);

    // 처리된 항목 인덱스에 추가 (감사/통계용)
    await this.redis.sadd('dlq:processed', dlqId);

    this.logger.log(`DLQ 수동 처리 완료: ${dlqId} - ${processorNote}`);
  }

  /**
   * DLQ 통계 조회
   */
  async getStats(): Promise<DLQStats> {
    const activeIds = await this.redis.smembers('dlq:job_ids');
    const highPriorityIds = await this.redis.smembers('dlq:high_priority');
    const processedIds = await this.redis.smembers('dlq:processed');

    let oldestFailure: string | undefined;
    for (const dlqId of activeIds) {
      const dlqData = await this.redis.hgetall(`dlq:${dlqId}`);
      if (!oldestFailure || dlqData.failedAt < oldestFailure) {
        oldestFailure = dlqData.failedAt;
      }
    }

    return {
      totalActive: activeIds.length,
      highPriority: highPriorityIds.length,
      totalProcessed: processedIds.length,
      oldestFailure,
    };
  }
}
