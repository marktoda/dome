/**
 * Context system for dome vault - hierarchical folder-based configuration
 */

export interface DomeContext {
  /** Human-readable name for this context */
  name: string;
  
  /** Description of what this context is used for */
  description: string;
  
  /** Template configuration for new notes in this context */
  template?: {
    /** Frontmatter fields to include in new notes */
    frontmatter?: Record<string, any>;
    /** Content template for new notes (can include placeholders like {title}, {date}) */
    content?: string;
  };
  
  /** Rules for notes in this context */
  rules?: {
    /** File naming pattern (e.g., "YYYY-MM-DD-{title}") */
    fileNaming?: string;
    /** Fields that must be present in frontmatter */
    requiredFields?: string[];
    /** Tags to automatically apply to notes in this context */
    autoTags?: string[];
  };
  
  /** Instructions for AI when working with notes in this context */
  aiInstructions?: string;
}

/**
 * Result of validating a note against its context
 */
export interface ValidationResult {
  /** Whether the note is valid according to context rules */
  isValid: boolean;
  /** List of validation errors if any */
  errors: ValidationError[];
  /** List of warnings that don't prevent validity */
  warnings: ValidationWarning[];
}

/**
 * Validation error for context rules
 */
export interface ValidationError {
  /** Type of validation error */
  type: 'missing_field' | 'invalid_filename' | 'missing_tag' | 'other';
  /** Human-readable error message */
  message: string;
  /** Field name if applicable */
  field?: string;
}

/**
 * Validation warning for context rules
 */
export interface ValidationWarning {
  /** Type of warning */
  type: 'suggested_field' | 'naming_convention' | 'other';
  /** Human-readable warning message */
  message: string;
  /** Field name if applicable */
  field?: string;
}

/**
 * Options for loading context
 */
export interface ContextLoadOptions {
  /** Whether to inherit from parent contexts */
  inheritFromParent?: boolean;
  /** Maximum depth to search for parent contexts */
  maxDepth?: number;
}

/**
 * Result of finding context for a path
 */
export interface ContextSearchResult {
  /** The context that applies to this path */
  context: DomeContext;
  /** Path to the .dome file that defines this context */
  contextFilePath: string;
  /** Whether this context was inherited from a parent */
  isInherited: boolean;
  /** Inheritance depth (0 = direct, 1 = parent, etc.) */
  depth: number;
}