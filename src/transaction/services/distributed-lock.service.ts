import { Injectable, Logger } from '@nestjs/common';
import { Redis } from 'ioredis';
import { ResourceIdentifier } from '../types/transaction.types';

@Injectable()
export class DistributedLockService {
  private readonly logger = new Logger(DistributedLockService.name);
  private readonly LOCK_PREFIX = 'tx_lock:';

  constructor(private readonly redis: Redis) {}

  /**
   * 리소스별 락 키 생성
   */
  private generateResourceLockKeys(
    resourceIdentifiers: ResourceIdentifier[],
  ): string[] {
    return resourceIdentifiers.map((resource) => {
      const action = resource.action ? `_${resource.action}` : '';
      return `${this.LOCK_PREFIX}${resource.type}_${resource.id}${action}`;
    });
  }

  /**
   * 분산락 획득 (리소스별)
   */
  async acquireLock(
    resourceIdentifiers: ResourceIdentifier[],
    jobId: string,
    ttl: number = parseInt(process.env.TRANSACTION_LOCK_TTL_SECONDS || '30'),
  ): Promise<boolean> {
    const lockKeys = this.generateResourceLockKeys(resourceIdentifiers);

    const lockResults: boolean[] = [];
    const acquiredKeys: string[] = [];

    try {
      for (const lockKey of lockKeys) {
        const acquired = await this.redis.set(lockKey, jobId, 'EX', ttl, 'NX');
        lockResults.push(!!acquired);

        if (acquired) {
          acquiredKeys.push(lockKey);
          this.logger.debug(`락 획득: ${lockKey} -> ${jobId}`);
        } else {
          await this.releaseLockInternal(acquiredKeys, jobId);
          return false;
        }
      }

      return lockResults.every((result) => result);
    } catch (error) {
      await this.releaseLockInternal(acquiredKeys, jobId);
      throw error;
    }
  }

  async releaseLock(
    resourceIdentifiers: ResourceIdentifier[],
    jobId: string,
  ): Promise<void> {
    const lockKeys = this.generateResourceLockKeys(resourceIdentifiers);
    await this.releaseLockInternal(lockKeys, jobId);
  }

  /**
   * 내부 락 해제 함수 (소유자 검증 포함)
   */
  private async releaseLockInternal(
    lockKeys: string[],
    jobId: string,
  ): Promise<void> {
    // Lua 스크립트로 원자적 소유자 검증 + 삭제
    const luaScript = `
      local deletedCount = 0
      for i, key in ipairs(KEYS) do
        local currentValue = redis.call('GET', key)
        if currentValue == ARGV[1] then
          redis.call('DEL', key)
          deletedCount = deletedCount + 1
        end
      end
      return deletedCount
    `;

    try {
      const deletedCount = (await this.redis.eval(
        luaScript,
        lockKeys.length,
        ...lockKeys,
        jobId,
      )) as number;

      this.logger.debug(
        `락 해제: ${deletedCount}/${lockKeys.length}개 해제 (jobId: ${jobId})`,
      );

      // 로깅으로 소유자 불일치 상황 추적
      if (deletedCount < lockKeys.length) {
        const unmatchedKeys = lockKeys.length - deletedCount;
        this.logger.warn(
          `락 소유자 불일치: ${unmatchedKeys}개 키에서 jobId ${jobId}와 불일치`,
        );
      }
    } catch (error) {
      this.logger.error(`락 해제 중 오류: jobId=${jobId}`, error);
      throw error;
    }
  }

  /**
   * 락 상태 확인 (디버깅/모니터링용)
   */
  async getLockStatus(
    resourceIdentifiers: ResourceIdentifier[],
  ): Promise<Record<string, string | null>> {
    const lockKeys = this.generateResourceLockKeys(resourceIdentifiers);
    const status: Record<string, string | null> = {};

    for (const lockKey of lockKeys) {
      status[lockKey] = await this.redis.get(lockKey);
    }

    return status;
  }
}
