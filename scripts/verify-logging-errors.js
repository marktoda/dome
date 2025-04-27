#!/usr/bin/env node

/**
 * Verification script for @dome/logging and @dome/errors usage
 * 
 * This script scans all services and verifies:
 * 1. Proper import and usage of @dome/logging
 * 2. Proper import and usage of @dome/errors
 * 3. Absence of console.log statements
 * 4. Correct error handling patterns
 * 5. Request ID propagation
 * 6. Appropriate log level usage
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Configuration
const SERVICES_DIR = path.resolve(__dirname, '../services');
const REPORT_FILE = path.resolve(__dirname, '../docs/LOGGING_VERIFICATION.md');

// Patterns to search for
const PATTERNS = {
  // Correct patterns
  DOME_LOGGING_IMPORT: /@dome\/logging/,
  DOME_ERRORS_IMPORT: /@dome\/errors/,
  LOG_ERROR_USAGE: /logError\(/,
  REQUEST_ID_PROPAGATION: /requestId|x-request-id/i,
  TRACK_OPERATION: /trackOperation\(/,
  
  // Incorrect patterns
  CONSOLE_LOG: /console\.log\(/,
  CONSOLE_ERROR: /console\.error\(/,
  CONSOLE_WARN: /console\.warn\(/,
  CONSOLE_INFO: /console\.info\(/,
  THROW_STRING: /throw ['"`]/,
  THROW_NEW_ERROR: /throw new Error\(/,
};

// Log levels to verify
const LOG_LEVELS = ['error', 'warn', 'info', 'debug'];

// Results
const results = {
  services: {},
  summary: {
    totalServices: 0,
    servicesUsingDomeLogging: 0,
    servicesUsingDomeErrors: 0,
    servicesMissingProperLogging: 0,
    servicesMissingProperErrors: 0,
    consoleLogViolations: 0,
    improperErrorHandling: 0,
  }
};

/**
 * Checks if a file matches a pattern
 */
function checkPattern(filePath, pattern) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return pattern.test(content);
  } catch (err) {
    return false;
  }
}

/**
 * Count occurrences of a pattern in a file
 */
function countOccurrences(filePath, pattern) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const matches = content.match(new RegExp(pattern, 'g'));
    return matches ? matches.length : 0;
  } catch (err) {
    return 0;
  }
}

/**
 * Gets all TypeScript/JavaScript files in a directory recursively
 */
function getSourceFiles(dir, fileList = []) {
  const files = fs.readdirSync(dir);
  
  files.forEach(file => {
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);
    
    if (stat.isDirectory() && file !== 'node_modules' && file !== 'dist' && !file.startsWith('.')) {
      getSourceFiles(filePath, fileList);
    } else if (/\.(ts|js|tsx|jsx)$/.test(file) && !file.endsWith('.d.ts')) {
      fileList.push(filePath);
    }
  });
  
  return fileList;
}

/**
 * Process a service directory
 */
function processService(serviceName, serviceDir) {
  console.log(`Processing service: ${serviceName}`);
  const sourceFiles = getSourceFiles(serviceDir);
  
  // Initialize results for this service
  results.services[serviceName] = {
    name: serviceName,
    sourceFiles: sourceFiles.length,
    usingDomeLogging: false,
    usingDomeErrors: false,
    consoleLogViolations: [],
    improperErrorHandling: [],
    logLevelUsage: {
      error: 0,
      warn: 0,
      info: 0,
      debug: 0,
    },
    requestIdPropagation: false,
    operationTracking: false,
  };

  // Check package.json for dependencies
  try {
    const packageJsonPath = path.join(serviceDir, 'package.json');
    if (fs.existsSync(packageJsonPath)) {
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
      const dependencies = { ...packageJson.dependencies, ...packageJson.devDependencies };
      
      results.services[serviceName].usingDomeLogging = !!dependencies['@dome/logging'];
      results.services[serviceName].usingDomeErrors = !!dependencies['@dome/errors'];
    }
  } catch (err) {
    console.error(`Error checking package.json for ${serviceName}:`, err);
  }

  // Check source files
  sourceFiles.forEach(filePath => {
    const relativePath = path.relative(SERVICES_DIR, filePath);
    
    // Check for correct patterns
    if (!results.services[serviceName].usingDomeLogging && checkPattern(filePath, PATTERNS.DOME_LOGGING_IMPORT)) {
      results.services[serviceName].usingDomeLogging = true;
    }
    
    if (!results.services[serviceName].usingDomeErrors && checkPattern(filePath, PATTERNS.DOME_ERRORS_IMPORT)) {
      results.services[serviceName].usingDomeErrors = true;
    }
    
    if (checkPattern(filePath, PATTERNS.LOG_ERROR_USAGE)) {
      results.services[serviceName].hasLogErrorUsage = true;
    }
    
    if (checkPattern(filePath, PATTERNS.REQUEST_ID_PROPAGATION)) {
      results.services[serviceName].requestIdPropagation = true;
    }
    
    if (checkPattern(filePath, PATTERNS.TRACK_OPERATION)) {
      results.services[serviceName].operationTracking = true;
    }
    
    // Check for log level usage
    LOG_LEVELS.forEach(level => {
      const regex = new RegExp(`logger\\.${level}\\(|log\\.${level}\\(`, 'g');
      results.services[serviceName].logLevelUsage[level] += countOccurrences(filePath, regex);
    });
    
    // Check for incorrect patterns
    if (checkPattern(filePath, PATTERNS.CONSOLE_LOG)) {
      results.services[serviceName].consoleLogViolations.push(relativePath);
    }
    
    if (checkPattern(filePath, PATTERNS.CONSOLE_ERROR) || 
        checkPattern(filePath, PATTERNS.CONSOLE_WARN) || 
        checkPattern(filePath, PATTERNS.CONSOLE_INFO)) {
      results.services[serviceName].consoleLogViolations.push(relativePath);
    }
    
    if (checkPattern(filePath, PATTERNS.THROW_STRING) || checkPattern(filePath, PATTERNS.THROW_NEW_ERROR)) {
      results.services[serviceName].improperErrorHandling.push(relativePath);
    }
  });
}

/**
 * Run a ripgrep command on services directory
 */
function runRipgrep(pattern) {
  try {
    return execSync(`cd ${SERVICES_DIR} && rg -l "${pattern}" --type ts --type js`, { encoding: 'utf8' })
      .trim()
      .split('\n')
      .filter(Boolean);
  } catch (error) {
    if (error.status === 1) {
      // Status 1 means no matches found
      return [];
    }
    console.error(`Error running ripgrep: ${error.message}`);
    return [];
  }
}

/**
 * Generate a summary
 */
function generateSummary() {
  results.summary.totalServices = Object.keys(results.services).length;
  
  for (const serviceName in results.services) {
    const service = results.services[serviceName];
    
    if (service.usingDomeLogging) {
      results.summary.servicesUsingDomeLogging++;
    } else {
      results.summary.servicesMissingProperLogging++;
    }
    
    if (service.usingDomeErrors) {
      results.summary.servicesUsingDomeErrors++;
    } else {
      results.summary.servicesMissingProperErrors++;
    }
    
    results.summary.consoleLogViolations += service.consoleLogViolations.length;
    results.summary.improperErrorHandling += service.improperErrorHandling.length;
  }
}

/**
 * Generate Markdown report
 */
function generateReport() {
  let report = `# Logging and Error Handling Verification Report\n\n`;
  report += `*Generated on ${new Date().toISOString()}*\n\n`;
  
  // Summary
  report += `## Summary\n\n`;
  report += `- **Total Services**: ${results.summary.totalServices}\n`;
  report += `- **Services using @dome/logging**: ${results.summary.servicesUsingDomeLogging}\n`;
  report += `- **Services using @dome/errors**: ${results.summary.servicesUsingDomeErrors}\n`;
  report += `- **Services missing proper logging**: ${results.summary.servicesMissingProperLogging}\n`;
  report += `- **Services missing proper error handling**: ${results.summary.servicesMissingProperErrors}\n`;
  report += `- **Total console.log violations**: ${results.summary.consoleLogViolations}\n`;
  report += `- **Total improper error handling**: ${results.summary.improperErrorHandling}\n\n`;
  
  // Service details
  report += `## Service Details\n\n`;
  
  for (const serviceName in results.services) {
    const service = results.services[serviceName];
    
    report += `### ${serviceName}\n\n`;
    report += `- **Source Files**: ${service.sourceFiles}\n`;
    report += `- **Using @dome/logging**: ${service.usingDomeLogging ? '✅' : '❌'}\n`;
    report += `- **Using @dome/errors**: ${service.usingDomeErrors ? '✅' : '❌'}\n`;
    report += `- **Request ID Propagation**: ${service.requestIdPropagation ? '✅' : '❌'}\n`;
    report += `- **Operation Tracking**: ${service.operationTracking ? '✅' : '❌'}\n`;
    report += `- **Log Level Usage**:\n`;
    report += `  - Error: ${service.logLevelUsage.error}\n`;
    report += `  - Warn: ${service.logLevelUsage.warn}\n`;
    report += `  - Info: ${service.logLevelUsage.info}\n`;
    report += `  - Debug: ${service.logLevelUsage.debug}\n`;
    
    if (service.consoleLogViolations.length > 0) {
      report += `- **Console.log Violations**:\n`;
      service.consoleLogViolations.forEach(file => {
        report += `  - \`${file}\`\n`;
      });
    }
    
    if (service.improperErrorHandling.length > 0) {
      report += `- **Improper Error Handling**:\n`;
      service.improperErrorHandling.forEach(file => {
        report += `  - \`${file}\`\n`;
      });
    }
    
    report += `\n`;
  }
  
  // Technical debt section
  report += `## Technical Debt\n\n`;
  report += `This section lists issues that should be addressed in future improvements:\n\n`;
  
  for (const serviceName in results.services) {
    const service = results.services[serviceName];
    const issues = [];
    
    if (!service.usingDomeLogging) {
      issues.push('Migrate to @dome/logging');
    }
    
    if (!service.usingDomeErrors) {
      issues.push('Migrate to @dome/errors');
    }
    
    if (service.consoleLogViolations.length > 0) {
      issues.push('Replace console.log statements with structured logging');
    }
    
    if (service.improperErrorHandling.length > 0) {
      issues.push('Replace raw Error throws with DomeError');
    }
    
    if (!service.requestIdPropagation) {
      issues.push('Implement request ID propagation');
    }
    
    if (!service.operationTracking) {
      issues.push('Implement operation tracking');
    }
    
    if (issues.length > 0) {
      report += `### ${serviceName}\n\n`;
      issues.forEach(issue => {
        report += `- ${issue}\n`;
      });
      report += `\n`;
    }
  }
  
  fs.writeFileSync(REPORT_FILE, report);
  console.log(`Report written to ${REPORT_FILE}`);
}

// Main execution
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
  
  // Generate summary and report
  generateSummary();
  generateReport();
}

main().catch(err => {
  console.error('Error running verification script:', err);
  process.exit(1);
});