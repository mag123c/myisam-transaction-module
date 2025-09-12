import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { Logger, ValidationPipe } from '@nestjs/common';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    cors: true,
    logger: new Logger(),
  });

  app.useGlobalPipes(new ValidationPipe());

  const port = process.env.PORT ?? 3000;
  await app.listen(port);

  Logger.log(`MyISAM 트랜잭션 모듈 서버 실행됨 - http://localhost:${port}`);
}

bootstrap();
