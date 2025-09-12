export interface TransactionStep {
  name: string;
  execute: () => Promise<any>;
  compensate: (result: any) => Promise<void> | void;
}

export interface ResourceIdentifier {
  type: string; // 리소스 타입 (확장 가능)
  id: string | number;
  action?: string;
}

export interface JobStepData {
  name: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  index: number;
  result: any;
}

export interface JobData {
  userId: number;
  steps: JobStepData[];
  currentStepIndex: number;
  createdAt: string;
  idempotencyKey?: string;
  resourceIdentifiers: ResourceIdentifier[];
}

// 범용 비즈니스 도메인 타입들
export interface CustomerInfo {
  userId: number;
  [key: string]: any; // 도메인별 확장 가능
}

export interface DLQData {
  id: string;
  originalJobId: string;
  originalJobData: JobData;
  failureReason: string;
  failureStack?: string;
  failedAt: string;

  // 비즈니스 메타데이터 (도메인 중립적)
  completedBenefits: string[];
  failedStep: string;
  customerInfo: CustomerInfo;
  manualActionRequired: string;
  priority: 'high' | 'normal';
  canRetry: boolean;

  // 확장 가능한 비즈니스 컨텍스트
  businessContext?: Record<string, any>;
}

export interface DLQStats {
  totalActive: number;
  highPriority: number;
  totalProcessed: number;
  oldestFailure?: string;
}
