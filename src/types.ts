// Transformation

export type ConfigTransformResult = {
  totalConfigCount: number | undefined;
  validConfigs: StatsigConfig[];
  errorsByConfigName: Record<string, TransformError[]>;
};

export type TransformResult<T> =
  | {
      transformed: true;
      result: T;
    }
  | {
      transformed: false;
      errors: TransformError[];
    };

export type TransformError = {
  flagKey: string;
} & (
  | {
      type: 'fetch_error';
      message: string;
    }
  | {
      type: 'unsupported_flag_kind';
      flagKind: string;
    }
  | {
      type: 'unit_id_not_mapped';
      contextKind: string;
    }
  | {
      type: 'custom_attribute_not_mapped';
      contextKind: string;
      attribute: string;
    }
  | {
      type: 'unsupported_pass_percentage';
    }
  | {
      type: 'unsupported_operator';
      operator: string;
    }
  | {
      type: 'invalid_clause_values';
      operator: string;
      values: unknown[];
    }
);

export function transformErrorToString(error: TransformError): string {
  switch (error.type) {
    case 'fetch_error':
      return `Error fetching flag: ${error.message}`;
    case 'unsupported_flag_kind':
      return `Unsupported flag kind: ${error.flagKind}`;
    case 'unit_id_not_mapped':
      return `Unit ID not mapped for context kind: ${error.contextKind}`;
    case 'custom_attribute_not_mapped':
      return `Custom attribute not mapped for context kind: ${error.contextKind}.${error.attribute}`;
    case 'unsupported_pass_percentage':
      return `Unsupported pass percentage`;
    case 'unsupported_operator':
      return `Unsupported operator: ${error.operator}`;
    case 'invalid_clause_values':
      return `Invalid clause values: ${error.operator} with values: ${error.values.join(', ')}`;
    default:
      const exhaustive: never = error;
      return exhaustive;
  }
}

// Statsig API Types

export type StatsigEnvironment = {
  name: string;
  isProduction: boolean;
  requiresReview: boolean;
};

export type StatsigConfig = {
  type: 'gate';
  gate: StatsigGate;
  overrides: StatsigOverride[];
};

export type StatsigGate = {
  id: string;
  name: string;
  description?: string;
  tags?: string[];
  type?: 'PERMANENT' | 'TEMPORARY';
  rules: StatsigRule[];
};

export type StatsigRule = {
  name: string;
  passPercentage: number;
  conditions: StatsigCondition[];
  environments?: string[];
};

export type StatsigCondition = {
  type: StatsigConditionType;
  customID?: string | null;
  field?: string | null;
  operator?: StatsigOperatorType;
  targetValue?: number | string | number[] | string[];
};

export type StatsigConditionType =
  | 'app_version'
  | 'browser_name'
  | 'browser_version'
  | 'country'
  | 'custom_field'
  | 'email'
  | 'environment_tier'
  | 'fails_gate'
  | 'fails_segment'
  | 'ip_address'
  | 'locale'
  | 'os_name'
  | 'os_version'
  | 'passes_gate'
  | 'passes_segment'
  | 'public'
  | 'time'
  | 'unit_id'
  | 'user_id'
  | 'device_model'
  | 'target_app';

export type StatsigOperatorType =
  | 'any'
  | 'none'
  | 'any_case_sensitive'
  | 'none_case_sensitive'
  | 'str_contains_any'
  | 'str_contains_none'
  | 'gt'
  | 'lt'
  | 'lte'
  | 'gte'
  | 'version_gt'
  | 'version_lt'
  | 'version_gte'
  | 'version_lte'
  | 'version_eq'
  | 'after'
  | 'before'
  | 'on'
  | 'is_null'
  | 'is_not_null'
  | 'str_matches'
  | 'encoded_any'
  | 'array_contains_any'
  | 'array_contains_none'
  | 'array_contains_all'
  | 'not_array_contains_all';

export type StatsigOverride = {
  environment: string | null;
  unitID: string;
  passingIDs: string[];
  failingIDs: string[];
};
