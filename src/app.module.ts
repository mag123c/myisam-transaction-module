import { Module } from '@nestjs/common';
import { DatabaseModule } from 'src/infra/database/database.module';
import { ConfigModule } from '@nestjs/config';
import { SimpleTransactionModule } from 'src/transaction/simple-transaction.module';
import { BullModule } from '@nestjs/bullmq';

@Module({
  imports: [
    // infra
    DatabaseModule,

    // BullMQ 설정
    BullModule.forRoot({
      connection: {
        host: process.env.REDIS_HOST || 'localhost',
        port: parseInt(process.env.REDIS_PORT || '6379'),
      },
    }),
    BullModule.registerQueue({
      name: 'Transaction',
    }),

    // transaction module
    SimpleTransactionModule,

    // config
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
  ],
})
export class AppModule {}
