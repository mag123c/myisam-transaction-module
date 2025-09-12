import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 시딩 시작...');

  // 기존 데이터 정리 (개발 환경에서만)
  if (process.env.NODE_ENV !== 'production') {
    console.log('🧹 기존 데이터 정리 중...');
    await prisma.smsNotification.deleteMany();
    await prisma.paymentHistory.deleteMany();
    await prisma.order.deleteMany();
    await prisma.payment.deleteMany();
    await prisma.cartItem.deleteMany();
    await prisma.cart.deleteMany();
    await prisma.product.deleteMany();
    await prisma.company.deleteMany();
    await prisma.user.deleteMany();
  }

  // 1. 테스트 고객 생성
  console.log('👤 고객 데이터 생성 중...');
  const users = await prisma.user.createMany({
    data: [
      {
        email: 'bride@wedding.com',
        name: '김신부',
        phone: '010-1234-5678',
        iCashBalance: 100000, // 10만원 아이캐시 보유
      },
      {
        email: 'groom@wedding.com',
        name: '이신랑',
        phone: '010-9876-5432',
        iCashBalance: 50000, // 5만원 아이캐시 보유
      },
      {
        email: 'customer@wedding.com',
        name: '박고객',
        phone: '010-1111-2222',
        iCashBalance: 0, // 아이캐시 없음
      },
    ],
  });

  // 2. 웨딩 업체 생성
  console.log('🏢 업체 데이터 생성 중...');
  const companies = await prisma.company.createMany({
    data: [
      {
        name: '로얄웨딩홀',
        email: 'royal@wedding.com',
        phone: '02-1234-5678',
      },
      {
        name: '프리미엄드레스',
        email: 'dress@wedding.com',
        phone: '02-2345-6789',
      },
      {
        name: '스타일메이크업',
        email: 'makeup@wedding.com',
        phone: '02-3456-7890',
      },
    ],
  });

  // 3. 웨딩 상품/서비스 생성
  console.log('🎁 상품 데이터 생성 중...');
  const products = await prisma.product.createMany({
    data: [
      // 웨딩홀 관련
      {
        name: '로얄홀 웨딩패키지',
        price: 3000000,
        category: '웨딩홀',
      },
      {
        name: '클래식 웨딩드레스',
        price: 800000,
        category: '드레스',
      },
      {
        name: '브라이덜 메이크업',
        price: 300000,
        category: '메이크업',
      },
      {
        name: '스튜디오 웨딩촬영',
        price: 600000,
        category: '촬영',
      },
    ],
  });

  // 4. 테스트용 장바구니 생성 (결제 테스트를 위해)
  console.log('🛒 테스트 장바구니 생성 중...');

  // 첫 번째 고객 데이터 조회
  const firstUser = await prisma.user.findFirst({
    where: { email: 'bride@wedding.com' },
  });

  const testProducts = await prisma.product.findMany({
    take: 3, // 처음 3개 상품
  });

  if (firstUser && testProducts.length > 0) {
    // 테스트 장바구니 생성
    const testCart = await prisma.cart.create({
      data: {
        userId: firstUser.id,
        status: 'PENDING',
        totalAmount: 0, // 아이템 추가 후 계산
      },
    });

    // 장바구니에 상품 추가
    const cartItemsData = testProducts.map((product) => ({
      cartId: testCart.id,
      productId: product.id,
      quantity: 1,
      price: product.price,
    }));

    await prisma.cartItem.createMany({
      data: cartItemsData,
    });

    // 총 금액 계산 및 업데이트
    const totalAmount = testProducts.reduce(
      (sum, product) => sum + product.price,
      0,
    );
    await prisma.cart.update({
      where: { id: testCart.id },
      data: { totalAmount },
    });

    console.log(
      `✅ 테스트 장바구니 생성 완료 (총액: ${totalAmount.toLocaleString()}원)`,
    );
  }

  console.log('✨ 시딩 완료!');
  console.log('📊 생성된 데이터:');

  const userCount = await prisma.user.count();
  const companyCount = await prisma.company.count();
  const productCount = await prisma.product.count();
  const cartCount = await prisma.cart.count();

  console.log(`- 고객: ${userCount}명`);
  console.log(`- 업체: ${companyCount}개`);
  console.log(`- 상품: ${productCount}개`);
  console.log(`- 장바구니: ${cartCount}개`);
}

main()
  .catch((e) => {
    console.error('❌ 시딩 실패:', e);
    process.exit(1);
  })
  .finally(() => {
    prisma.$disconnect();
  });
