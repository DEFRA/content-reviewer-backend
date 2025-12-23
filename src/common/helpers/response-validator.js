/**
 * Response Validation Utility for DEFRA AI Content Review Tool
 * 
 * This module validates LLM responses to ensure they meet all required standards
 * for structure, completeness, and data quality.
 */

// Required sections that MUST be present in every response
const REQUIRED_SECTIONS = [
  'Content Suitability Assessment',
  'Title Analysis',
  'Summary Evaluation',
  'Body Text Analysis',
  'Style Guide Compliance',
  'Govspeak Markdown Analysis',
  'Accessibility Checks',
  'User Experience Assessment',
  'Passive Voice Review',
  'GOV.UK Words to Avoid Review',
  'Summary of Findings'
];

// Required data points that must be extracted
const REQUIRED_DATA_POINTS = {
  title_character_count: { type: 'number', min: 0, max: 200 },
  summary_character_count: { type: 'number', min: 0, max: 500 },
  forbidden_words_count: { type: 'number', min: 0, max: 1000 },
  body_word_count: { type: 'number', min: 0, max: 100000 },
  passive_sentences_count: { type: 'number', min: 0, max: 1000 }
};

// Required components in Summary of Findings
const REQUIRED_SUMMARY_COMPONENTS = [
  'Critical Issues',
  'High Priority',
  'Medium Priority',
  'Low Priority',
  'Overall Assessment',
  'Top 3 Improvements'
];

/**
 * Validates the complete LLM response
 * @param {string} response - The raw LLM response
 * @returns {Object} Validation result with status and details
 */
function validateResponse(response) {
  const result = {
    valid: true,
    level: 'pass', // pass, warn, fail
    errors: [],
    warnings: [],
    sections: {},
    metadata: null,
    completeness: 0
  };

  try {
    // Step 1: Extract markdown and JSON parts
    const { markdown, json } = extractParts(response);
    
    // Step 2: Validate JSON metadata presence and structure
    const jsonValidation = validateJSON(json);
    if (!jsonValidation.valid) {
      result.valid = false;
      result.level = 'fail';
      result.errors.push(...jsonValidation.errors);
      return result;
    }
    result.metadata = jsonValidation.data;

    // Step 3: Validate all required sections are present
    const sectionValidation = validateSections(markdown);
    result.sections = sectionValidation.sections;
    result.completeness = sectionValidation.completeness;
    
    if (!sectionValidation.valid) {
      result.valid = false;
      result.level = 'fail';
      result.errors.push(...sectionValidation.errors);
    }

    // Step 4: Validate required data points
    const dataValidation = validateDataPoints(result.metadata);
    if (!dataValidation.valid) {
      result.level = result.level === 'fail' ? 'fail' : 'warn';
      result.warnings.push(...dataValidation.warnings);
    }

    // Step 5: Validate Summary of Findings structure
    const summaryValidation = validateSummaryStructure(markdown);
    if (!summaryValidation.valid) {
      result.valid = false;
      result.level = 'fail';
      result.errors.push(...summaryValidation.errors);
    }

    // Step 6: Cross-validate JSON against markdown
    const crossValidation = crossValidateData(markdown, result.metadata);
    if (!crossValidation.valid) {
      result.level = result.level === 'fail' ? 'fail' : 'warn';
      result.warnings.push(...crossValidation.warnings);
    }

  } catch (error) {
    result.valid = false;
    result.level = 'fail';
    result.errors.push(`Validation error: ${error.message}`);
  }

  return result;
}

/**
 * Extract markdown and JSON parts from response
 */
function extractParts(response) {
  const jsonMatch = response.match(/```json\s*(\{[\s\S]*?\})\s*```/);
  
  if (!jsonMatch) {
    throw new Error('No JSON metadata block found in response');
  }

  const jsonStr = jsonMatch[1];
  const markdown = response.substring(0, jsonMatch.index).trim();

  let json;
  try {
    json = JSON.parse(jsonStr);
  } catch (error) {
    throw new Error(`Invalid JSON: ${error.message}`);
  }

  return { markdown, json };
}

/**
 * Validate JSON metadata structure
 */
function validateJSON(json) {
  const result = { valid: true, errors: [], data: null };

  if (!json || !json.validation_metadata) {
    result.valid = false;
    result.errors.push('Missing validation_metadata in JSON');
    return result;
  }

  const metadata = json.validation_metadata;

  // Check sections_completed
  if (!Array.isArray(metadata.sections_completed)) {
    result.valid = false;
    result.errors.push('sections_completed must be an array');
  } else if (metadata.sections_completed.length !== 11) {
    result.valid = false;
    result.errors.push(`Expected 11 sections, found ${metadata.sections_completed.length}`);
  }

  // Check data_points
  if (!metadata.data_points || typeof metadata.data_points !== 'object') {
    result.valid = false;
    result.errors.push('Missing or invalid data_points object');
  }

  // Check issue_counts
  if (!metadata.issue_counts || typeof metadata.issue_counts !== 'object') {
    result.valid = false;
    result.errors.push('Missing or invalid issue_counts object');
  }

  // Check completeness_score
  if (typeof metadata.completeness_score !== 'number') {
    result.valid = false;
    result.errors.push('completeness_score must be a number');
  }

  result.data = metadata;
  return result;
}

/**
 * Validate all required sections are present in markdown
 */
function validateSections(markdown) {
  const result = {
    valid: true,
    errors: [],
    sections: {},
    completeness: 0
  };

  const foundSections = [];

  REQUIRED_SECTIONS.forEach(sectionName => {
    // Check for section header (## Section Name)
    const regex = new RegExp(`^##\\s+${sectionName}\\s*$`, 'im');
    const found = regex.test(markdown);
    
    result.sections[sectionName] = found;
    if (found) {
      foundSections.push(sectionName);
    }
  });

  result.completeness = Math.round((foundSections.length / REQUIRED_SECTIONS.length) * 100);

  if (foundSections.length < REQUIRED_SECTIONS.length) {
    result.valid = false;
    const missing = REQUIRED_SECTIONS.filter(s => !foundSections.includes(s));
    result.errors.push(`Missing required sections: ${missing.join(', ')}`);
  }

  return result;
}

/**
 * Validate required data points in metadata
 */
function validateDataPoints(metadata) {
  const result = { valid: true, warnings: [] };

  if (!metadata || !metadata.data_points) {
    result.valid = false;
    result.warnings.push('Missing data_points in metadata');
    return result;
  }

  const dataPoints = metadata.data_points;

  Object.entries(REQUIRED_DATA_POINTS).forEach(([key, config]) => {
    if (!(key in dataPoints)) {
      result.valid = false;
      result.warnings.push(`Missing data point: ${key}`);
      return;
    }

    const value = dataPoints[key];

    if (typeof value !== config.type) {
      result.valid = false;
      result.warnings.push(`${key} must be a ${config.type}, got ${typeof value}`);
      return;
    }

    if (config.type === 'number') {
      if (value < config.min || value > config.max) {
        result.valid = false;
        result.warnings.push(`${key} (${value}) out of range [${config.min}, ${config.max}]`);
      }
    }
  });

  return result;
}

/**
 * Validate Summary of Findings structure
 */
function validateSummaryStructure(markdown) {
  const result = { valid: true, errors: [] };

  // Extract Summary of Findings section
  const summaryMatch = markdown.match(/##\s+Summary of Findings\s*\n([\s\S]*?)(?=\n##|\n```json|$)/i);
  
  if (!summaryMatch) {
    result.valid = false;
    result.errors.push('Summary of Findings section not found or improperly formatted');
    return result;
  }

  const summaryContent = summaryMatch[1];

  // Check for required components
  REQUIRED_SUMMARY_COMPONENTS.forEach(component => {
    const regex = new RegExp(`\\*\\*${component}[:\\*]`, 'i');
    if (!regex.test(summaryContent)) {
      result.valid = false;
      result.errors.push(`Missing required component in summary: ${component}`);
    }
  });

  // Check Overall Assessment is not empty
  const assessmentMatch = summaryContent.match(/\*\*Overall Assessment[:\*]\*\*\s*\n+([\s\S]*?)(?=\n\*\*|$)/i);
  if (!assessmentMatch || assessmentMatch[1].trim().length < 50) {
    result.valid = false;
    result.errors.push('Overall Assessment must contain at least 50 characters of content');
  }

  return result;
}

/**
 * Cross-validate JSON metadata against markdown content
 */
function crossValidateData(markdown, metadata) {
  const result = { valid: true, warnings: [] };

  if (!metadata) return result;

  // Validate sections_completed matches actual sections
  const declaredSections = metadata.sections_completed || [];
  declaredSections.forEach(section => {
    if (!REQUIRED_SECTIONS.includes(section)) {
      result.valid = false;
      result.warnings.push(`Unknown section in metadata: ${section}`);
    }
  });

  // Check issue counts are reasonable
  if (metadata.issue_counts) {
    const { critical, high, medium, low, total } = metadata.issue_counts;
    const sum = (critical || 0) + (high || 0) + (medium || 0) + (low || 0);
    
    if (total !== sum) {
      result.valid = false;
      result.warnings.push(`Issue count mismatch: total (${total}) != sum of priorities (${sum})`);
    }
  }

  return result;
}

/**
 * Generate retry prompt with specific missing elements
 */
function generateRetryPrompt(validationResult, originalContent) {
  let retryPrompt = `Your previous response was incomplete. Please provide a COMPLETE review that includes:\n\n`;

  if (validationResult.errors.length > 0) {
    retryPrompt += `**Missing/Invalid Elements:**\n`;
    validationResult.errors.forEach(error => {
      retryPrompt += `- ${error}\n`;
    });
    retryPrompt += `\n`;
  }

  // List missing sections
  const missingSections = REQUIRED_SECTIONS.filter(s => !validationResult.sections[s]);
  if (missingSections.length > 0) {
    retryPrompt += `**Missing Sections:**\n`;
    missingSections.forEach(section => {
      retryPrompt += `- ${section}\n`;
    });
    retryPrompt += `\n`;
  }

  retryPrompt += `**Requirements:**\n`;
  retryPrompt += `1. Include ALL 11 required sections (even if no issues found, use ✅)\n`;
  retryPrompt += `2. Provide JSON metadata block at the end\n`;
  retryPrompt += `3. Include character counts for title and summary\n`;
  retryPrompt += `4. Include all 4 priority levels in Summary of Findings\n`;
  retryPrompt += `5. Write an Overall Assessment (at least 50 characters)\n`;
  retryPrompt += `6. List Top 3 Improvements\n\n`;

  retryPrompt += `Please analyze this content again with complete coverage:\n\n${originalContent}`;

  return retryPrompt;
}

export {
  validateResponse,
  generateRetryPrompt,
  REQUIRED_SECTIONS,
  REQUIRED_DATA_POINTS,
  REQUIRED_SUMMARY_COMPONENTS
};
