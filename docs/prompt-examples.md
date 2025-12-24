# Example Outputs for DEFRA AI Content Review Tool

This document provides examples of how the LLM should respond to different types of content submissions. These examples demonstrate the expected format, tone, and level of detail.

---

## Example 1: News Article with Multiple Issues

### User Input:
```
Title: Government Delivers New Initiative to Combat Climate Change

Summary: The government has launched a new initiative to tackle climate change.

Body:
The government is pleased to announce that we have deployed a robust framework to deliver improvements in our environmental policies. This transformational agenda will facilitate collaboration between key stakeholders and empower communities to take action.

We will leverage cutting-edge technology to incentivise sustainable practices. The initiative was developed by our expert team and will be rolled out nationally.

For more information click here: www.example.gov.uk
```

### Expected LLM Output:

## Content Suitability Assessment

**Appropriateness for GOV.UK:** ✅ Yes, this appears to be appropriate government content about environmental policy.

**Duplication Check:** ⚠️ Climate change initiatives are common on GOV.UK. Check if this duplicates existing content at `/government/news` or under `/environment/climate-change`. If this is an update to an existing policy, consider updating the existing page rather than creating new content.

**User Need:** ⚠️ Partially clear. Users need to know about new environmental policies, but the content needs to specify:
- What exactly is this initiative?
- Who is it for?
- What action (if any) can users take?

**Content Type Appropriateness:** ✅ News article format is appropriate for announcing a new initiative.

---

## Title Analysis

**Current title:** "Government Delivers New Initiative to Combat Climate Change"

**Character count:** 64 characters (including spaces) ✅ Under 65-character limit

**Issues identified:**

❌ **Contains forbidden words:**
- "Delivers" - GOV.UK words to avoid list (pizzas and services are delivered, not abstract concepts)
- "Combat" - GOV.UK words to avoid list (unless military context)

❌ **Lacks specificity:** "New Initiative" is vague. What is the initiative called? What does it do?

❌ **Search optimization:** Missing concrete keywords users might search for (e.g., specific environmental action, policy name, affected groups)

**Suggested alternatives:**
- "New grants to help businesses reduce carbon emissions" (58 characters)
- "£10 million fund launched to support green technology" (54 characters)
- "Business climate action plan published" (41 characters)

---

## Summary Evaluation

**Current summary:** "The government has launched a new initiative to tackle climate change."

**Character count:** 71 characters ✅ Under 160-character limit

**Issues identified:**

❌ **Repeats the title:** The summary essentially restates the title without adding new information.

❌ **Contains forbidden word:** "Tackle" - GOV.UK words to avoid list (unless fishing or rugby context). Use "stop," "solve," or "deal with."

❌ **Lacks detail:** Doesn't explain what the initiative is, who it affects, or what action users should take.

❌ **Missing user benefit:** Doesn't answer "why should I care?"

**Suggested alternative:**
"Find out about new grants available for businesses to reduce carbon emissions and support sustainable practices." (119 characters)

---

## Body Text Analysis

**Word count:** 84 words

**Information Hierarchy:** ❌ Opens with "pleased to announce" throat-clearing. Start with the most important information for users.

**Scannability:** ❌ Only 2 paragraphs with no subheadings. For this length, it's acceptable, but longer content would need breaking up.

**Plain English Issues:**

❌ **Forbidden words identified:**
1. "delivered" (line 1) - Use "make," "create," or be specific
2. "combat" (line 1) - Use "solve," "stop," or "deal with"  
3. "deployed" (line 1) - Use "use," "build," or "put into place"
4. "robust" (line 1) - Use "well thought out" or "comprehensive"
5. "deliver" (line 1) - Use "make" or be specific
6. "transformational" (line 2) - Describe the specific change
7. "agenda" (line 2) - Use "plan"
8. "facilitate" (line 2) - Be specific about how you're helping
9. "collaboration" (line 2) - Use "work with"
10. "key" (line 2) - Use "important" or remove
11. "empower" (line 2) - Use "allow" or "give permission"
12. "leverage" (line 3) - Use "use"
13. "incentivise" (line 3) - Use "encourage" or "motivate"

**Sentence Length Check:**
✅ All sentences are under 25 words.

**Acronyms:** ✅ None used.

**Technical Terms:** ✅ "Stakeholders" could be more specific (e.g., "businesses and local councils").

---

## Style Guide Compliance

❌ **Link text violation:** "click here" - Links must be descriptive. Use text like "Read about the climate initiative" or "Apply for environmental grants"

❌ **Government organization:** "The government is pleased..." - Remove "pleased" (opinion language). Just state facts: "The government has announced..."

✅ **Numbers:** No numbers present to check.

✅ **"and" vs "&":** Correctly uses "and."

---

## Govspeak Markdown Analysis

**Issues identified:**

❌ **Missing markdown:** The content appears to be plain text. It should include:
- Proper heading formatting (##, ###)
- Link markdown: `[descriptive text](https://www.example.gov.uk)`

**Example of correctly formatted content:**
```markdown
## What the initiative includes

The government has announced a new environmental plan. It will:

* provide grants for businesses
* support sustainable practices
* help communities take action

[Apply for environmental grants](https://www.example.gov.uk/apply)
```

---

## Accessibility Checks

✅ **Images:** None present.

✅ **Emojis:** None used.

❌ **Plain language:** Multiple instances of jargon and complex phrases need simplification.

✅ **Barriers:** No major accessibility barriers beyond language complexity.

---

## User Experience Assessment

❌ **Audience Needs:** Content is too vague to meet user needs. Users likely want to know:
- Am I eligible for something?
- Do I need to do something?
- What are the specifics of this initiative?

✅ **Mobile Experience:** Short paragraphs work well on mobile.

⚠️ **Simplified Presentation:** Consider using a bullet list to break down what the initiative includes.

---

## Passive Voice Review

**Passive sentences found:**

1. ❌ **"The initiative was developed by our expert team"**
   - Why it's passive: Subject (the initiative) receives the action rather than performing it
   - ✅ Active alternative: "Our expert team developed the initiative"

2. ❌ **"will be rolled out"**
   - Why it's passive: No clear actor performing the action
   - ✅ Active alternative: "We will roll out the initiative" or "The initiative starts in March 2025"

---

## GOV.UK Words to Avoid Review

**All forbidden words found with alternatives:**

1. **Line 1: "Delivers"**
   - Category: Abstract delivery
   - ❌ Original: "Government Delivers New Initiative"
   - ✅ Alternative: "Government announces new initiative" or "Government launches new plan"

2. **Line 1: "Combat"**
   - Category: Non-military combat
   - ❌ Original: "Combat Climate Change"
   - ✅ Alternative: "stop climate change" or "reduce carbon emissions"

3. **Line 2: "Deployed"**
   - Category: Non-military deployment
   - ❌ Original: "deployed a robust framework"
   - ✅ Alternative: "put in place a comprehensive framework" or "created a framework"

4. **Line 2: "Robust"**
   - Category: Non-physical robustness
   - ❌ Original: "robust framework"
   - ✅ Alternative: "comprehensive framework" or "well thought out framework"

5. **Line 2: "Deliver improvements"**
   - Category: Abstract delivery
   - ❌ Original: "deliver improvements in our environmental policies"
   - ✅ Alternative: "make improvements to our environmental policies" or "improve our environmental policies"

6. **Line 3: "Transformational agenda"**
   - Category: Transform (vague) and agenda (non-meeting)
   - ❌ Original: "transformational agenda"
   - ✅ Alternative: "plan to [specific change]" - be specific about what's changing

7. **Line 3: "Facilitate collaboration"**
   - Category: Facilitate and collaborate
   - ❌ Original: "facilitate collaboration between key stakeholders"
   - ✅ Alternative: "help businesses and councils work together"

8. **Line 3: "Key stakeholders"**
   - Category: Key (non-unlocking)
   - ❌ Original: "key stakeholders"
   - ✅ Alternative: "important stakeholders" or better yet, be specific: "businesses, councils, and community groups"

9. **Line 3: "Empower communities"**
   - Category: Empower
   - ❌ Original: "empower communities to take action"
   - ✅ Alternative: "allow communities to take action" or "help communities take action"

10. **Line 4: "Leverage cutting-edge technology"**
    - Category: Leverage (non-financial)
    - ❌ Original: "leverage cutting-edge technology"
    - ✅ Alternative: "use new technology"

11. **Line 4: "Incentivise sustainable practices"**
    - Category: Incentivise
    - ❌ Original: "incentivise sustainable practices"
    - ✅ Alternative: "encourage sustainable practices" or "motivate businesses to adopt sustainable practices"

12. **Summary: "Tackle climate change"**
    - Category: Tackle (non-rugby)
    - ❌ Original: "tackle climate change"
    - ✅ Alternative: "deal with climate change" or "stop climate change"

---

## Summary of Findings

### Critical Issues (must be fixed):
1. **Title and summary repeat each other** - Summary must add new information
2. **Vague content** - Specify what the initiative actually is and who it affects
3. **Link text violation** - "Click here" is not accessible; use descriptive link text
4. **Missing Govspeak formatting** - Add proper markdown for headings and links

### High Priority (strongly recommended):
1. **13 instances of forbidden words** - All need replacing with plain English alternatives
2. **2 passive voice constructions** - Rewrite in active voice for clarity
3. **Lacks user-focused information** - Add who can benefit and what action they should take
4. **Opening "throat-clearing"** - Remove "pleased to announce" and start with key information

### Medium Priority (should address):
1. **"Stakeholders" is vague** - Specify who you mean (businesses, councils, etc.)
2. **Check for duplicate content** - Ensure this doesn't repeat existing GOV.UK pages
3. **Add subheadings** - If content expands, use H2 headings to break up sections

### Low Priority (nice to have):
1. Consider adding bullet points to list what the initiative includes
2. Add a call-to-action if users can apply for grants or take specific action

### Overall Assessment:

This content announces an important environmental initiative but needs significant revision before publication. The main issues are:

1. **Heavy use of jargon** - 13 forbidden words make the content difficult to understand
2. **Lacks specificity** - Users need to know exactly what this initiative is and who it affects
3. **Title and summary need work** - They repeat each other and don't provide enough detail

**Top 3 improvements needed:**
1. Rewrite to remove all jargon and use plain English throughout
2. Be specific about what the initiative includes and who it's for
3. Add proper Govspeak formatting with descriptive links and bullet points

**What's working well:**
- Appropriate content type for an announcement
- Short, scannable paragraphs
- No major accessibility barriers beyond language complexity

---

## Example 2: Guidance Page with Good Structure

### User Input:
```
Title: Apply for a business grant

Summary: Find out if you can get money to help your business reduce carbon emissions and how to apply.

Body:
## Who can apply

You can apply if you're a:

* small or medium-sized business
* registered company in the UK
* business that produces carbon emissions

## What you'll get

You can get up to £50,000 to:

* buy energy-efficient equipment
* install renewable energy systems
* train staff in sustainable practices

## How to apply

You'll need to:

s1. Check if you're eligible
s2. Gather your business documents
s3. Complete the online application form
s4. Submit your application

Applications close on 31 March 2025.

[Apply for the grant](https://www.gov.uk/apply-business-carbon-grant)
```

### Expected LLM Output:

## Content Suitability Assessment

**Appropriateness for GOV.UK:** ✅ Yes, this is appropriate guidance content for a government grant scheme.

**Duplication Check:** ✅ Appears unique. Verify no similar grant exists at `/business-finance-support` or `/environment/climate-change-energy`.

**User Need:** ✅ Clear user need: businesses want to know if they're eligible for grants and how to apply.

**Content Type Appropriateness:** ✅ Guidance format is perfect for explaining eligibility and process.

---

## Title Analysis

**Current title:** "Apply for a business grant"

**Character count:** 27 characters ✅ Well under 65-character limit

**Assessment:**

✅ **Clear and specific** - Users immediately know this is about applying for a grant

⚠️ **Could be more specific** - Consider mentioning what the grant is for to improve search optimization:
- "Apply for a business carbon reduction grant" (46 characters)
- "Get a grant to reduce your business carbon emissions" (53 characters)

✅ **Sentence case** - Correctly formatted

✅ **No jargon** - Plain English throughout

✅ **Search optimized** - Contains key terms: "apply," "business," "grant"

**Verdict:** Good title, but could be enhanced with more specificity if character count allows.

---

## Summary Evaluation

**Current summary:** "Find out if you can get money to help your business reduce carbon emissions and how to apply."

**Character count:** 102 characters ✅ Well under 160-character limit

**Assessment:**

✅ **Expands on title** - Adds information about reducing carbon emissions

✅ **Clear purpose** - Explains what users will learn (eligibility and process)

✅ **Complete sentence** - Properly structured with verb and full stop

✅ **Front-loaded keywords** - "Find out," "get money," "business" appear early

✅ **No jargon** - Excellent plain English

✅ **No acronyms** - None used

**Verdict:** Excellent summary. Clear, concise, and user-focused.

---

## Body Text Analysis

**Word count:** 72 words

✅ **Information Hierarchy:** Perfect! Opens with eligibility criteria (most important for users)

✅ **Scannability:** Excellent use of H2 headings and bullet points

✅ **Plain English:** No jargon or complex terms identified

✅ **Sentence Length:** All sentences well under 25 words

✅ **Acronyms:** "UK" correctly used without full stops

✅ **Technical Terms:** None requiring explanation

**Assessment:** Content is well-structured, clear, and user-focused. No issues identified.

---

## Style Guide Compliance

✅ **Bullet points:** Properly preceded by lead-in lines and start with lowercase

✅ **Numbers:** Correctly written as numerals (£50,000)

✅ **Date format:** "31 March 2025" - correctly formatted

✅ **Links:** Descriptive link text ("Apply for the grant" not "click here")

✅ **No bold, italics, or ALL CAPS:** Clean formatting throughout

✅ **"and" used correctly:** No inappropriate "&" usage

**Assessment:** Excellent compliance with GOV.UK style guide. No issues found.

---

## Govspeak Markdown Analysis

### Headings
✅ **Properly formatted:** All headings use `##` for H2
✅ **No skipped levels:** Consistent hierarchy
✅ **No H1 usage:** Correct - page title serves as H1

### Lists
✅ **Unordered lists:** Properly formatted with `*`
✅ **Ordered steps:** Correctly use `s1.`, `s2.`, `s3.`, `s4.` prefix

⚠️ **Missing line break:** Should have an extra blank line after the final step (`s4.`) and before "Applications close..."

### Links
✅ **Properly formatted:** `[Apply for the grant](URL)` is correct

### Special Elements
✅ **No special callouts needed** for this content type

**Minor issue identified:**
```markdown
s4. Submit your application

Applications close on 31 March 2025.
```

**Should be:**
```markdown
s4. Submit your application

Applications close on 31 March 2025.
```
(Extra blank line after step 4)

---

## Accessibility Checks

✅ **Images:** None present (none needed)

✅ **Emojis:** None used

✅ **Plain language:** Excellent - accessible to all reading levels

✅ **No barriers:** Content is clear and well-structured

✅ **Technical terms:** None requiring explanation

**Assessment:** This content has no accessibility issues. Well done!

---

## User Experience Assessment

✅ **Audience Needs:** Perfectly addresses user needs with clear eligibility, benefits, and process

✅ **Mobile Experience:** Short paragraphs and bullet points work excellently on mobile

✅ **Clear presentation:** Information is logically organized and easy to scan

**Assessment:** Excellent user experience. Content is structured exactly how users need it.

---

## Passive Voice Review

✅ **No passive voice found** - All sentences use active voice or are user-focused commands (e.g., "You can apply," "You'll need to").

---

## GOV.UK Words to Avoid Review

✅ **No forbidden words found** - Content uses plain English throughout.

---

## Summary of Findings

### Critical Issues (must be fixed):
None! 🎉

### High Priority (strongly recommended):
None

### Medium Priority (should address):
1. **Add blank line after step list** - Insert extra line break after `s4.` for proper Govspeak formatting

### Low Priority (nice to have):
1. **Consider more specific title** - Could mention "carbon reduction" for better search optimization
2. **Verify uniqueness** - Check no similar content exists elsewhere on GOV.UK

### Overall Assessment:

**This is excellent content that follows GOV.UK best practices almost perfectly.** It demonstrates:

- Clear, user-focused structure
- Excellent plain English throughout
- Proper use of headings and lists
- Good information hierarchy
- Strong accessibility

**Top improvement needed:**
- Add the missing line break after the step list (very minor formatting issue)

**What's working exceptionally well:**
- User-focused content that answers "can I apply?" and "how do I apply?"
- No jargon or forbidden words
- Perfect scannability with clear headings
- Descriptive link text
- All sentences under 25 words

**Recommendation:** Fix the minor Govspeak formatting issue and this content is ready for publication. This is a model example of how GOV.UK guidance should be written.

---

**JSON Metadata:**
```json
{
  "validation_metadata": {
    "sections_completed": [
      "Content Suitability Assessment",
      "Title Analysis",
      "Summary Evaluation",
      "Body Text Analysis",
      "Style Guide Compliance",
      "Govspeak Markdown Analysis",
      "Accessibility Checks",
      "User Experience Assessment",
      "Passive Voice Review",
      "GOV.UK Words to Avoid Review",
      "Summary of Findings"
    ],
    "data_points": {
      "title_character_count": 27,
      "summary_character_count": 102,
      "forbidden_words_count": 0,
      "body_word_count": 72,
      "passive_sentences_count": 0
    },
    "issue_counts": {
      "critical": 0,
      "high": 0,
      "medium": 1,
      "low": 1,
      "total": 2
    },
    "completeness_score": 100
  }
}
```

---

## Example 3: Content with Accessibility Issues

### User Input:
```
Title: Understanding Digital Transformation in Public Services 🚀

Summary: Read more about how we're modernising services.

Body:
Click here to download our strategy document (PDF)

The government is COMMITTED to delivering world-class digital services; leveraging AI & machine learning.

For further information contact: John.Smith@Example.Gov.UK
```

### Expected LLM Output:

## Content Suitability Assessment

**Appropriateness for GOV.UK:** ⚠️ Topic is appropriate, but execution has multiple issues.

**User Need:** ❌ Unclear. What do users need to know or do? Why should they read this?

---

## Title Analysis

**Current title:** "Understanding Digital Transformation in Public Services 🚀"

**Character count:** 63 characters (including emoji) ✅ Just under 65-character limit

**Critical issues:**

❌ **Contains emoji (🚀):** Emojis should NEVER be used on GOV.UK. They:
- Don't work well with screen readers
- Appear differently across devices
- Are not professional for government content

❌ **Contains forbidden word:** "Transformation" - describe the specific change instead

❌ **Too vague:** "Understanding Digital Transformation" doesn't tell users what they'll learn or do

**Suggested alternatives:**
- "How we're improving online government services" (47 characters)
- "New digital services for businesses and citizens" (50 characters)

---

## Summary Evaluation

**Current summary:** "Read more about how we're modernising services."

**Character count:** 49 characters ✅ Under 160 limit

**Critical issues:**

❌ **"Read more" is weak link text** - Doesn't add information beyond the title

❌ **Too vague** - Which services? How are they being modernised? Why should users care?

**Suggested alternative:**
"Find out about new online services that make it easier to access government support." (90 characters)

---

## Body Text Analysis

**Critical accessibility and style issues:**

❌ **"Click here"** - Forbidden link text. Links must be descriptive for screen readers.

❌ **Missing download information:** Must include file type and size in download links. Format: `$D [Strategy document](URL) (PDF, 2MB) $D`

❌ **ALL CAPS "COMMITTED"** - Do not use all capitals. Use normal case.

❌ **Semicolon** - GOV.UK style doesn't use semicolons. Use full stops or commas.

❌ **"&" symbol** - Use "and" instead (unless in official logos)

❌ **Incorrect email format:** Should be lowercase and consistent: `john.smith@example.gov.uk`

❌ **Forbidden words:** "delivering," "leveraging," "world-class," "transform"

---

## Govspeak Markdown Analysis

❌ **Download link not properly formatted:**

Current:
```
Click here to download our strategy document (PDF)
```

Should be:
```
$D
[Digital services strategy](https://www.gov.uk/strategy-doc) (PDF, 1.5MB)
$D
```

❌ **Email not properly formatted:**

Current:
```
John.Smith@Example.Gov.UK
```

Should be:
```
[john.smith@example.gov.uk](mailto:john.smith@example.gov.uk)
```
Or simply: `john.smith@example.gov.uk`

---

## Accessibility Checks

❌ **Emoji in title:** Fails accessibility - remove immediately

❌ **ALL CAPS text:** Difficult for screen readers and users with dyslexia

❌ **"Click here" link:** Not accessible - screen reader users who tab through links won't understand context

❌ **Inconsistent email capitalization:** Harder to read and type

---

## GOV.UK Words to Avoid Review

❌ **"Understanding" in title** - Too academic. Use "How," "Find out about," or "Learn about"

❌ **"Transform/Transformation"** - Describe the specific change

❌ **"Delivering... services"** - Use "providing," "making," or "creating"

❌ **"World-class"** - Subjective claim. Describe specific benefits instead

❌ **"Leveraging"** - Use "using"

❌ **"Modernising"** - Be specific about what improvements are being made

---

## Summary of Findings

### Critical Issues (must be fixed before publication):
1. **Remove emoji from title** - Accessibility violation
2. **Fix "click here" link** - Use descriptive text
3. **Remove ALL CAPS** - Use normal case
4. **Fix email format** - Use lowercase throughout
5. **Add proper download formatting** - Include file type and size with $D tags
6. **Remove semicolon** - Use full stop instead

### High Priority (strongly recommended):
1. **Rewrite title** - Remove "transformation," be specific about what's changing
2. **Expand summary** - Add meaningful information users need
3. **Replace forbidden words** - "Delivering," "leveraging," all need plain English alternatives
4. **Remove "&"** - Use "and"

### Medium Priority (should address):
1. **Add context** - Explain why users should care about this content
2. **Structure the body** - Add headings and break into scannable sections
3. **Be specific** - Replace vague terms like "world-class" with concrete benefits

### Overall Assessment:

**This content has multiple critical accessibility and style violations that must be fixed before publication.**

**Top 3 improvements needed:**
1. **Remove emoji and ALL CAPS** - These are accessibility violations
2. **Fix all link text and formatting** - "Click here" and improperly formatted downloads harm usability
3. **Replace all jargon** - 6+ forbidden words need plain English alternatives

**Critical message:** This content cannot be published in its current form due to accessibility violations. The emoji, ALL CAPS text, and poor link text would prevent some users from accessing the information effectively.

---

These examples demonstrate the **level of detail, constructive tone, and specific guidance** your LLM should provide. Each example shows different types of issues and how to handle them appropriately.
