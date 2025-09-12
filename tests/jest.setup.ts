import { config } from 'dotenv';

config({ path: '.env.test' });

jest.setTimeout(30000);

beforeAll(() => {
  console.log('MyISAM Transaction Module 통합 테스트 시작');
  console.log(`Redis 테스트 포트: ${process.env.REDIS_PORT}`);
  console.log(
    `데이터베이스: ${process.env.DATABASE_URL?.split('@')[1]?.split('/')[1]}`,
  );
});

afterAll(() => {
  console.log('모든 테스트 완료');
});
