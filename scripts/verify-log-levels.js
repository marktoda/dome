#!/usr/bin/env node

/**
 * Verification script for consistent log level usage
 * 
 * This script analyzes the log level usage patterns across all services
 * to ensure consistent and appropriate use of different log levels.
 * 
 * It checks:
 * 1. Distribution of log levels (error, warn, info, debug)
 * 2. Appropriate log level usage for different types of operations
 * 3. Consistent log level patterns across services
 * 
 * Usage:
 *   node scripts/verify-log-levels.js
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Configuration
const SERVICES_DIR = path.resolve(__dirname, '../services');
const LOG_LEVELS = ['error', 'warn', 'info', 'debug'];
const LOG_PATTERNS = {
  ERROR: /logger\.error\(/g,
  WARN: /logger\.warn\(/g,
  INFO: /logger\.info\(/g,
  DEBUG: /logger\.debug\(/g
};

// Operation patterns to check for appropriate log levels
const OPERATIONS = {
  REQUEST_START: { pattern: /request_start|requestStart/, expectedLevel: 'info' },
  REQUEST_END: { pattern: /request_end|requestEnd/, expectedLevel: 'info' },
  OPERATION_START: { pattern: /_start|Start/, expectedLevel: 'info' },
  OPERATION_SUCCESS: { pattern: /_success|Success/, expectedLevel: 'info' },
  OPERATION_FAILURE: { pattern: /_failure|Failure/, expectedLevel: 'error' },
  VALIDATION_ERROR: { pattern: /validation|invalid/i, expectedLevel: 'warn' },
  EXTERNAL_CALL: { pattern: /external_call|externalCall/, expectedLevel: 'info' },
  SYSTEM_ERROR: { pattern: /system error|unexpected/i, expectedLevel: 'error' },
  DATABASE_OPERATION: { pattern: /database|db_|db\./i, expectedLevel: 'info' }
};

// Results storage
const results = {
  services: {},
  summary: {
    totalServices: 0,
    totalLogStatements: 0,
    logLevelDistribution: {
      error: 0,
      warn: 0,
      info: 0,
      debug: 0
    },
    operationConsistency: {},
    recommendations: []
  }
};

/**
 * Gets all source files in a directory
 */
function getSourceFiles(dir, fileList = []) {
  if (!fs.existsSync(dir)) return fileList;
  
  const files = fs.readdirSync(dir);
  
  files.forEach(file => {
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);
    
    if (stat.isDirectory() && file !== 'node_modules' && file !== 'dist' && !file.startsWith('.')) {
      getSourceFiles(filePath, fileList);
    } else if (/\.(ts|js|tsx|jsx)$/.test(file) && !file.endsWith('.d.ts') && !file.endsWith('.test.ts')) {
      fileList.push(filePath);
    }
  });
  
  return fileList;
}

/**
 * Counts occurrences of a pattern in a file
 */
function countOccurrences(content, pattern) {
  const matches = content.match(pattern);
  return matches ? matches.length : 0;
}

/**
 * Process a single file
 */
function processFile(filePath, serviceData) {
  const content = fs.readFileSync(filePath, 'utf8');
  
  // Count log level occurrences
  LOG_LEVELS.forEach(level => {
    const pattern = level === 'error' ? LOG_PATTERNS.ERROR :
                   level === 'warn' ? LOG_PATTERNS.WARN :
                   level === 'info' ? LOG_PATTERNS.INFO :
                   LOG_PATTERNS.DEBUG;
                   
    const count = countOccurrences(content, pattern);
    serviceData.logLevelCounts[level] += count;
    results.summary.logLevelDistribution[level] += count;
    results.summary.totalLogStatements += count;
  });
  
  // Check operations for appropriate log levels
  for (const [opName, opData] of Object.entries(OPERATIONS)) {
    // Check if the operation appears in the file
    if (opData.pattern.test(content)) {
      // Extract log statements containing the operation
      const lines = content.split('\n');
      
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        
        if (opData.pattern.test(line)) {
          // Look for logger calls in this line and surrounding lines
          const context = lines.slice(Math.max(0, i - 3), Math.min(lines.length, i + 4)).join('\n');
          
          // Check which log level is used
          const usedLevel = LOG_LEVELS.find(level => {
            const pattern = level === 'error' ? LOG_PATTERNS.ERROR :
                          level === 'warn' ? LOG_PATTERNS.WARN :
                          level === 'info' ? LOG_PATTERNS.INFO :
                          LOG_PATTERNS.DEBUG;
            return pattern.test(context);
          }) || 'unknown';
          
          // Record the usage
          if (!serviceData.operations[opName]) {
            serviceData.operations[opName] = {
              count: 0,
              levels: {}
            };
          }
          
          serviceData.operations[opName].count++;
          serviceData.operations[opName].levels[usedLevel] = (serviceData.operations[opName].levels[usedLevel] || 0) + 1;
          
          // Also update summary
          if (!results.summary.operationConsistency[opName]) {
            results.summary.operationConsistency[opName] = {
              expectedLevel: opData.expectedLevel,
              usage: {}
            };
          }
          
          if (!results.summary.operationConsistency[opName].usage[usedLevel]) {
            results.summary.operationConsistency[opName].usage[usedLevel] = 0;
          }
          results.summary.operationConsistency[opName].usage[usedLevel]++;
        }
      }
    }
  }
}

/**
 * Process a service directory
 */
function processService(serviceName, serviceDir) {
  console.log(`Processing service: ${serviceName}`);
  
  // Initialize service data
  results.services[serviceName] = {
    name: serviceName,
    logLevelCounts: {
      error: 0,
      warn: 0,
      info: 0,
      debug: 0
    },
    operations: {},
    issues: []
  };
  
  // Process all source files
  const sourceFiles = getSourceFiles(serviceDir);
  sourceFiles.forEach(filePath => {
    processFile(filePath, results.services[serviceName]);
  });
  
  // Check for common issues
  const serviceData = results.services[serviceName];
  
  // No error logging
  if (serviceData.logLevelCounts.error === 0) {
    serviceData.issues.push('No error logging used');
  }
  
  // Excessive debug logging
  const totalLogStatements = LOG_LEVELS.reduce((sum, level) => sum + serviceData.logLevelCounts[level], 0);
  if (serviceData.logLevelCounts.debug > totalLogStatements * 0.5) {
    serviceData.issues.push('Excessive debug logging (>50% of logs)');
  }
  
  // Check for inconsistent operation log levels
  for (const [opName, opData] of Object.entries(serviceData.operations)) {
    const expectedLevel = OPERATIONS[opName].expectedLevel;
    
    // Check if the operation uses a different level than expected
    const totalOpCount = Object.values(opData.levels).reduce((sum, count) => sum + count, 0);
    const correctLevelCount = opData.levels[expectedLevel] || 0;
    
    if (correctLevelCount < totalOpCount * 0.7) {
      serviceData.issues.push(`Inconsistent log level for ${opName}: expected ${expectedLevel}`);
    }
  }
}

/**
 * Generate recommendations based on analysis
 */
function generateRecommendations() {
  const summary = results.summary;
  
  // Check overall distribution
  const totalLogs = summary.totalLogStatements;
  const errorPercentage = Math.round((summary.logLevelDistribution.error / totalLogs) * 100);
  const warnPercentage = Math.round((summary.logLevelDistribution.warn / totalLogs) * 100);
  const infoPercentage = Math.round((summary.logLevelDistribution.info / totalLogs) * 100);
  const debugPercentage = Math.round((summary.logLevelDistribution.debug / totalLogs) * 100);
  
  // Ideal distribution guidance
  if (errorPercentage < 5) {
    summary.recommendations.push('Consider increasing error logging for critical issues (recommended: 5-10%)');
  }
  
  if (warnPercentage < 10) {
    summary.recommendations.push('Consider increasing warning logging for potential issues (recommended: 10-15%)');
  }
  
  if (infoPercentage < 50) {
    summary.recommendations.push('Consider increasing info logging for operational visibility (recommended: 50-70%)');
  }
  
  if (debugPercentage > 30) {
    summary.recommendations.push('Consider reducing debug logging in production code (recommended: 10-15%)');
  }
  
  // Check operation consistency
  for (const [opName, opData] of Object.entries(summary.operationConsistency)) {
    const expectedLevel = opData.expectedLevel;
    const usageLevels = Object.keys(opData.usage);
    
    if (usageLevels.length > 1) {
      // Operation is logged at multiple levels
      const totalUsage = Object.values(opData.usage).reduce((sum, count) => sum + count, 0);
      const correctLevelUsage = opData.usage[expectedLevel] || 0;
      const correctPercentage = Math.round((correctLevelUsage / totalUsage) * 100);
      
      if (correctPercentage < 70) {
        summary.recommendations.push(
          `Standardize logging for ${opName} operations to use ${expectedLevel} level (currently: ${correctPercentage}%)`
        );
      }
    }
  }
  
  // Service-specific recommendations
  for (const serviceName in results.services) {
    const service = results.services[serviceName];
    
    if (service.issues.length > 0) {
      summary.recommendations.push(`Service ${serviceName} needs attention: ${service.issues.join(', ')}`);
    }
  }
}

/**
 * Generate markdown report
 */
function generateReport() {
  let report = `# Log Level Usage Analysis\n\n`;
  report += `*Generated on ${new Date().toISOString()}*\n\n`;
  
  // Summary section
  report += `## Summary\n\n`;
  report += `- **Total Services Analyzed**: ${results.summary.totalServices}\n`;
  report += `- **Total Log Statements**: ${results.summary.totalLogStatements}\n\n`;
  
  // Log level distribution
  report += `### Log Level Distribution\n\n`;
  report += `| Level | Count | Percentage |\n`;
  report += `|-------|-------|------------|\n`;
  
  LOG_LEVELS.forEach(level => {
    const count = results.summary.logLevelDistribution[level];
    const percentage = Math.round((count / results.summary.totalLogStatements) * 100);
    report += `| ${level} | ${count} | ${percentage}% |\n`;
  });
  
  report += `\n`;
  
  // Operation consistency
  report += `### Operation Log Level Consistency\n\n`;
  report += `| Operation | Expected Level | Consistency |\n`;
  report += `|-----------|----------------|-------------|\n`;
  
  for (const [opName, opData] of Object.entries(results.summary.operationConsistency)) {
    const expectedLevel = opData.expectedLevel;
    const totalUsage = Object.values(opData.usage).reduce((sum, count) => sum + count, 0);
    const correctLevelUsage = opData.usage[expectedLevel] || 0;
    const correctPercentage = Math.round((correctLevelUsage / totalUsage) * 100);
    
    const consistencyStatus = correctPercentage >= 90 ? '✅ High' :
                            correctPercentage >= 70 ? '🟨 Medium' :
                            '❌ Low';
    
    report += `| ${opName} | ${expectedLevel} | ${consistencyStatus} (${correctPercentage}%) |\n`;
  }
  
  report += `\n`;
  
  // Service details
  report += `## Service Details\n\n`;
  
  for (const serviceName in results.services) {
    const service = results.services[serviceName];
    
    report += `### ${serviceName}\n\n`;
    
    // Log level counts
    report += `#### Log Level Distribution\n\n`;
    report += `| Level | Count | Percentage |\n`;
    report += `|-------|-------|------------|\n`;
    
    const totalServiceLogs = LOG_LEVELS.reduce((sum, level) => sum + service.logLevelCounts[level], 0);
    
    LOG_LEVELS.forEach(level => {
      const count = service.logLevelCounts[level];
      const percentage = totalServiceLogs > 0 ? Math.round((count / totalServiceLogs) * 100) : 0;
      report += `| ${level} | ${count} | ${percentage}% |\n`;
    });
    
    report += `\n`;
    
    // Operation consistency
    if (Object.keys(service.operations).length > 0) {
      report += `#### Operation Log Levels\n\n`;
      report += `| Operation | Expected Level | Used Levels |\n`;
      report += `|-----------|----------------|-------------|\n`;
      
      for (const [opName, opData] of Object.entries(service.operations)) {
        const expectedLevel = OPERATIONS[opName].expectedLevel;
        const usedLevels = Object.entries(opData.levels)
          .map(([level, count]) => `${level} (${count})`)
          .join(', ');
        
        report += `| ${opName} | ${expectedLevel} | ${usedLevels} |\n`;
      }
      
      report += `\n`;
    }
    
    // Issues
    if (service.issues.length > 0) {
      report += `#### Issues\n\n`;
      service.issues.forEach(issue => {
        report += `- ${issue}\n`;
      });
      report += `\n`;
    }
  }
  
  // Recommendations
  report += `## Recommendations\n\n`;
  results.summary.recommendations.forEach(recommendation => {
    report += `- ${recommendation}\n`;
  });
  
  const reportPath = path.resolve(__dirname, '../docs/LOG_LEVEL_ANALYSIS.md');
  fs.writeFileSync(reportPath, report);
  console.log(`Report written to ${reportPath}`);
}

/**
 * Main execution
 */
async function main() {
  // Get all service directories
  const services = fs.readdirSync(SERVICES_DIR)
    .filter(item => {
      const itemPath = path.join(SERVICES_DIR, item);
      return fs.statSync(itemPath).isDirectory() && !item.startsWith('.');
    });

  results.summary.totalServices = services.length;
  
  // Process each service
  services.forEach(serviceName => {
    const serviceDir = path.join(SERVICES_DIR, serviceName);
    processService(serviceName, serviceDir);
  });
  
  // Generate recommendations
  generateRecommendations();
  
  // Generate report
  generateReport();
  
  console.log('Log level analysis complete!');
}

main().catch(err => {
  console.error('Error running analysis script:', err);
  process.exit(1);
});