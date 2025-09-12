import { Module } from '@nestjs/common';
import { SimpleTransactionManager } from './simple-transaction-manager';
import { SimpleTransactionConsumer } from './simple-transaction.consumer';
import { DistributedLockService } from './services/distributed-lock.service';
import { DLQService } from './services/dlq.service';
import { CompensationService } from './services/compensation.service';

@Module({
  providers: [
    SimpleTransactionManager,
    SimpleTransactionConsumer,
    DistributedLockService,
    DLQService,
    CompensationService,
  ],
  exports: [
    SimpleTransactionManager,
    DistributedLockService,
    DLQService,
    CompensationService,
  ],
})
export class SimpleTransactionModule {}
