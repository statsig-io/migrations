// Transformation

export type ConfigTransformResult = {
  totalConfigCount: number | undefined;
  totalFlagCount: number | undefined;
  totalSegmentCount: number | undefined;
  validConfigs: StatsigConfig[];
  noticesByConfigName: Record<string, TransformNotice[]>;
  errorsByConfigName: Record<string, TransformError[]>;
};

export type TransformResult<T> =
  | {
      transformed: true;
      result: T;
      notices?: TransformNotice[];
    }
  | {
      transformed: false;
      errors: TransformError[];
    };

export type TransformNotice = {
  type: 'return_value_wrapped';
  flagKey: string;
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
  | {
      type: 'unsupported_off_variation';
      flagEnvironmentName: string;
    }
  | {
      type: 'return_value_contains_null';
    }
  | {
      type: 'unsupported_segment_type';
    }
  | {
      type: 'segment_has_exclusions';
    }
);

// Statsig API Types

export type StatsigEnvironment = {
  name: string;
  isProduction: boolean;
  requiresReview: boolean;
};

export type StatsigConfig =
  | {
      type: 'gate';
      gate: StatsigGate;
      overrides: StatsigOverride[];
    }
  | {
      type: 'dynamic_config';
      dynamicConfig: StatsigDynamicConfig;
    }
  | {
      type: 'segment';
      segment: StatsigSegment;
    };

export type StatsigGate = {
  id: string;
  name: string;
  description?: string;
  tags?: string[];
  type?: 'PERMANENT' | 'TEMPORARY';
  rules: StatsigRule[];
};

export type StatsigDynamicConfig = {
  id: string;
  name: string;
  description?: string;
  tags?: string[];
  rules: StatsigDynamicConfigRule[];
};

export type StatsigSegment = {
  id: string;
  name: string;
  description?: string;
  type: 'id_list' | 'rule_based';
  idType?: string;
  tags?: string[];
  rules: StatsigRule[];
};

export type StatsigRule = {
  name: string;
  passPercentage?: number;
  conditions: StatsigCondition[];
  environments?: string[];
};

export type StatsigDynamicConfigRule = StatsigRule & {
  returnValue?: Record<string, unknown>;
  variants?: StatsigDynamicConfigVariant[];
};

export type StatsigDynamicConfigVariant = {
  name: string;
  passPercentage: number;
  returnValue: Record<string, unknown>;
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
