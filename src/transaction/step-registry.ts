/**
 * 트랜잭션 Step 함수 레지스트리
 * 서버 재시작과 스케일 아웃에 안전한 함수 관리
 */

export interface StepFunction {
  name: string;
  execute: () => Promise<any>;
  compensate?: (result: any) => Promise<void> | void;
}

export interface StepExecution {
  execute: () => Promise<any>;
  compensate?: (result: any) => Promise<void> | void;
}

export class StepRegistry {
  private static instance: StepRegistry;
  private steps: Map<string, StepFunction> = new Map();

  private constructor() {}

  static getInstance(): StepRegistry {
    if (!StepRegistry.instance) {
      StepRegistry.instance = new StepRegistry();
    }
    return StepRegistry.instance;
  }

  /**
   * Step 함수 등록
   */
  register(
    name: string,
    execute: () => Promise<any>,
    compensate?: (result: any) => Promise<void> | void,
  ): void {
    // 동일한 이름이 있으면 덮어쓰기 (테스트 환경에서 유용)
    this.steps.set(name, {
      name,
      execute,
      compensate,
    });
  }

  /**
   * Step 함수 조회
   */
  get(name: string): StepFunction | undefined {
    return this.steps.get(name);
  }

  /**
   * 등록된 모든 Step 이름 조회
   */
  getRegisteredSteps(): string[] {
    return Array.from(this.steps.keys());
  }

  /**
   * 등록된 모든 Step 이름 조회 (alias)
   */
  listSteps(): string[] {
    return this.getRegisteredSteps();
  }

  /**
   * Step 등록 여부 확인
   */
  has(name: string): boolean {
    return this.steps.has(name);
  }

  /**
   * Step 등록 해제 (테스트용)
   */
  unregister(name: string): boolean {
    return this.steps.delete(name);
  }

  /**
   * 모든 Step 초기화 (테스트용)
   */
  clear(): void {
    this.steps.clear();
  }
}

/**
 * 전역 Step Registry 인스턴스
 */
export const stepRegistry = StepRegistry.getInstance();
