/** Phrases that read as orders to a coding agent; a tester's report is data, and has none. */
const ORDERS: readonly RegExp[] = [
  /\bignore (?:all|any|the|your|every)?\s*(?:previous|prior|above|earlier|instructions|rules)\b/i,
  /\bignore all\b/i,
  /\bdisregard\b[^\n]{0,40}\b(?:instructions|rules|above|previous|prior)\b/i,
  /\byou (?:must|should|need to|have to|are to|will now)\b/i,
  /\b(?:new|updated|real|system) instructions?\b/i,
  /\b(?:run|execute|exec|invoke|type)\b[^\n`]{0,30}`[^`\n]+`/i,
  /\bgit\s+(?:push|reset\s+--hard|clean\b|checkout\s+--|commit\b)/i,
  /\b(?:curl|wget)\b[^\n|]*\|\s*(?:ba|z)?sh\b/i,
  /\brm\s+-[a-z]*[rf]/i,
  /\bsudo\b/i,
  /\bsubmit\s*[("'`]/i,
  /\bapply stress-scout fix\b/i,
  /<\/?(?:system|assistant|instructions?)>/i,
]

/** Whether any of the texts reads like an instruction, so a report holding it is never applied unattended. */
export const looksLikeInstruction = (...texts: readonly string[]): boolean =>
  texts.some(text => ORDERS.some(order => order.test(text)))
