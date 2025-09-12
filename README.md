# MyISAM Transaction Module

> MyISAM 환경에서 ACID 속성을 보장하는 애플리케이션 레벨 트랜잭션 시스템

## 프로젝트 개요

MyISAM 스토리지 엔진의 한계로 인한 데이터 정합성 문제를 해결하기 위해 개발된 트랜잭션 모듈입니다. BullMQ와 Redis를 활용하여 분산 환경에서도 ACID 속성을 보장하는 논리적 트랜잭션 시스템을 구현했습니다.

### 해결하고자 한 문제

- **MyISAM 한계**: 트랜잭션 미지원으로 인한 데이터 부정합 발생
- **비즈니스 리스크**: 결제, 포인트 처리 등 핵심 비즈니스 로직의 원자성 보장 불가
- **운영 부담**: 데이터 정합성 관련 CS 대응 및 수동 복구 작업

## 아키텍처

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   Client API    │    │  Redis (Lock)   │    │     MySQL       │
│                 │    │                 │    │   (MyISAM)      │
└─────────┬───────┘    └─────────┬───────┘    └─────────┬───────┘
          │                      │                      │
          │              ┌───────▼───────┐              │
          │              │ Distributed   │              │
          │              │     Lock      │              │
          │              └───────────────┘              │
          │                                             │
          ▼                                             ▼
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│ Transaction     │───▶│     BullMQ      │───▶│ Step Execution  │
│   Manager       │    │   Job Queue     │    │ & Compensation  │
└─────────────────┘    └─────────────────┘    └─────────────────┘
```

## 핵심 기능

### 1. 분산 트랜잭션 처리
- **Step-by-Step 실행**: 복잡한 비즈니스 로직을 단계별로 분할 처리
- **보상 트랜잭션**: 실패 시 이미 실행된 단계들을 역순으로 롤백
- **원자성 보장**: 모든 단계가 성공하거나 모든 단계가 롤백되는 All-or-Nothing 보장

### 2. 동시성 제어
- **Redis 분산락 + Lua 스크립트**: 원자성 보장 및 소유권 검증으로 race condition 방지
- **Job 단위 격리**: BullMQ를 통한 안전한 순차 처리
- **TTL 일관성**: 환경변수 기반 락 타임아웃 중앙 관리

### 3. 장애 복구 및 DX 개선
- **중단 지점 재개**: 장애 복구 시 중단된 지점부터 자동 재시작
- **DLQ 시스템**: 복구 불가능한 작업의 별도 처리 및 통계
- **보상 트랜잭션 자동화**: 기존 try/catch 수동 처리에서 전은 자동화
- **상태 추적**: 트랜잭션 진행 상황 실시간 모니터링

## 기술 스택
- **코어**: NestJS + TypeScript / MySQL(MyISAM) / Redis / BullMQ
- **모니터링**: Prometheus + Grafana + Loki (외부 인프라)

## 성과
- **데이터 정합성**: 부정합 CS 제로화
- **장애 대응**: 수동 데이터 복구 → 자동 DLQ 처리
- **운영 안정성**: MyISAM 환경에서 논리적 ACID 속성 보장
- **개발자 경험(DX)**: 수동 보상 트랜잭션 코드 100% 감소

## 테스트 시나리오
1. **성공 시나리오**: 5단계 결제 프로세스 (재고→결제→차감→완료→알림)
2. **보상 트랜잭션**: 중간 실패 시 자동 롤백 검증
3. **동시성 제어**: 분산락을 통한 race condition 방지
4. **데이터 일관성**: 복잡한 다중 엔티티 처리 검증

## 프로젝트 구조

```
src/
└── transaction/
    ├── simple-transaction-manager.ts    # 트랜잭션 관리자 (핵심 로직)
    ├── simple-transaction.consumer.ts   # BullMQ 컨슈머 (Job 처리)
    ├── simple-transaction.module.ts     # NestJS 모듈 구성
    ├── step-registry.ts                 # Step 함수 레지스트리
    ├── services/
    │   ├── distributed-lock.service.ts   # Lua 스크립트 기반 분산락
    │   ├── compensation.service.ts       # 보상 트랜잭션 처리
    │   └── dlq.service.ts                # Dead Letter Queue 처리
    ├── types/
    │   └── transaction.types.ts          # TypeScript 타입 정의
    └── index.ts                         # Public API exports

tests/
├── transaction-manager.test.ts          # 핵심 기능 테스트
├── transaction-resume.test.ts           # 중단 지점 재개 테스트
├── transaction-consumer-safety.test.ts  # 동시성 제어 테스트
└── dlq-myisam-limits.test.ts           # MyISAM 한계 시나리오 테스트
```

## 코드 예시

### 트랜잭션 정의
```typescript
const paymentSteps: TransactionStep[] = [
  {
    name: 'validate_inventory',
    execute: async () => {
      // 재고 검증 및 락
      return { inventoryLocked: true };
    },
    compensate: async (result) => {
      // 재고 락 해제
    }
  },
  {
    name: 'create_payment',
    execute: async () => {
      // 결제 정보 생성
      return { paymentId: 'PAY_123' };
    },
    compensate: async (result) => {
      // 결제 정보 삭제
    }
  }
  // ... 추가 단계들
];
```

### 트랜잭션 실행
```typescript
// 트랜잭션 시작
const jobId = await transactionManager.execute(userId, paymentSteps);

// 상태 확인
const status = await transactionManager.getStatus(jobId);
console.log(`Transaction Status: ${status.status}`);
```

## 기술적 도전과 해결

### 1. MyISAM 제약사항 극복
- **문제**: 트랜잭션 미지원으로 인한 데이터 정합성 이슈 + 수동 보상 로직의 DX 저하
- **해결**: BullMQ 기반 논리적 트랜잭션 + Step 패턴으로 보상 로직 자동화

### 2. 동시 Job 처리 시 원자성 보장
- **문제**: 여러 Job이 동일 리소스 락을 동시에 해제할 때 race condition 발생
- **해결**: Lua 스크립트 기반 원자적 compare-and-delete로 소유권 검증

### 3. 복잡한 보상 로직 관리 + DX 개선
- **문제**: 기존 try/catch 기반 수동 보상 → 코드 중복, 실수 위험, 장애 대응 복잡성
- **해결**:
  - Step Registry 패턴으로 보상 로직 표준화
  - TypeScript 타입 시스템으로 컴파일 타임 검증
  - DLQ + 자동 재시도로 장애 처리 체계화
