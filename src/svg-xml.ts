/**
 * A small strict XML reader for the SVG deck contract.
 *
 * The deck parser must reject ambiguous markup instead of guessing at it, and it
 * only needs elements, attributes and text. This reader therefore implements a
 * deliberate subset of XML 1.0: the prolog and doctype are skipped, comments are
 * skipped, the five predefined entities plus numeric character references are
 * decoded, attributes must be quoted, and everything else is an error carrying
 * a line and column. Namespaces are kept as literal names (`svg:rect` keeps its
 * prefix) so the deck layer can reject prefixed elements itself.
 */

export interface XmlAttribute {
  readonly name: string
  readonly value: string
  readonly line: number
  readonly column: number
}

export interface XmlText {
  readonly kind: 'text'
  readonly value: string
  /** True for `<![CDATA[…]]>` content, which is never entity-decoded. */
  readonly cdata: boolean
  readonly line: number
  readonly column: number
}

export interface XmlElement {
  readonly kind: 'element'
  readonly name: string
  readonly attributes: readonly XmlAttribute[]
  readonly children: readonly XmlNode[]
  readonly line: number
  readonly column: number
}

export type XmlNode = XmlElement | XmlText

export class XmlParseError extends Error {
  readonly line: number
  readonly column: number

  constructor(message: string, line: number, column: number) {
    super(`${message} (line ${line}, column ${column})`)
    this.name = 'XmlParseError'
    this.line = line
    this.column = column
  }
}

/** Hard guard so a hostile document cannot exhaust the stack before the deck limits run. */
const MAX_XML_DEPTH = 64

const NAMED_ENTITIES: ReadonlyMap<string, string> = new Map([
  ['amp', '&'],
  ['lt', '<'],
  ['gt', '>'],
  ['quot', '"'],
  ['apos', "'"],
])

const NAME_START = /[A-Za-z_]/u
const NAME_PART = /[A-Za-z0-9_.:-]/u

interface Position {
  line: number
  column: number
}

class Reader {
  private index = 0
  private line = 1
  private lineStart = 0

  constructor(private readonly source: string) {}

  parseDocument(): XmlElement {
    if (this.source.startsWith('\uFEFF')) this.advance(1)
    this.skipMisc(true)
    if (this.atEnd()) this.fail('the document has no root element')
    const root = this.parseElement(1)
    this.skipMisc(false)
    if (!this.atEnd()) this.fail('unexpected content after the root element')
    return root
  }

  private loc(): Position {
    return { line: this.line, column: this.index - this.lineStart + 1 }
  }

  private fail(message: string, at: Position = this.loc()): never {
    throw new XmlParseError(message, at.line, at.column)
  }

  private atEnd(): boolean {
    return this.index >= this.source.length
  }

  private peek(offset = 0): string | undefined {
    return this.source[this.index + offset]
  }

  private startsWith(token: string): boolean {
    return this.source.startsWith(token, this.index)
  }

  private advance(count = 1): void {
    for (let step = 0; step < count; step += 1) {
      if (this.index >= this.source.length) return
      if (this.source[this.index] === '\n') {
        this.line += 1
        this.lineStart = this.index + 1
      }
      this.index += 1
    }
  }

  private skipWhitespace(): void {
    for (;;) {
      const character = this.peek()
      if (character === ' ' || character === '\t' || character === '\r' || character === '\n') {
        this.advance(1)
        continue
      }
      return
    }
  }

  private skipMisc(allowDoctype: boolean): void {
    for (;;) {
      this.skipWhitespace()
      if (this.startsWith('<!--')) {
        this.skipComment()
        continue
      }
      if (this.startsWith('<?')) {
        this.skipInstruction()
        continue
      }
      if (allowDoctype && /^<!DOCTYPE/iu.test(this.source.slice(this.index, this.index + 9))) {
        this.skipDoctype()
        continue
      }
      return
    }
  }

  private skipComment(): void {
    const at = this.loc()
    this.advance('<!--'.length)
    const end = this.source.indexOf('-->', this.index)
    if (end < 0) this.fail('unterminated comment', at)
    while (this.index < end + '-->'.length) this.advance(1)
  }

  private skipInstruction(): void {
    const at = this.loc()
    this.advance('<?'.length)
    const end = this.source.indexOf('?>', this.index)
    if (end < 0) this.fail('unterminated processing instruction', at)
    while (this.index < end + '?>'.length) this.advance(1)
  }

  private skipDoctype(): void {
    const at = this.loc()
    this.advance('<!DOCTYPE'.length)
    let quote: string | undefined
    let brackets = 0
    for (;;) {
      const character = this.peek()
      if (character === undefined) this.fail('unterminated doctype', at)
      if (quote !== undefined) {
        if (character === quote) quote = undefined
        this.advance(1)
        continue
      }
      if (character === '"' || character === "'") {
        quote = character
        this.advance(1)
        continue
      }
      if (character === '[') {
        brackets += 1
        this.advance(1)
        continue
      }
      if (character === ']') {
        brackets = Math.max(0, brackets - 1)
        this.advance(1)
        continue
      }
      if (character === '>' && brackets === 0) {
        this.advance(1)
        return
      }
      this.advance(1)
    }
  }

  private readName(): string {
    const start = this.index
    const first = this.peek()
    if (first === undefined || !NAME_START.test(first)) this.fail('expected an XML name')
    this.advance(1)
    for (;;) {
      const character = this.peek()
      if (character === undefined || !NAME_PART.test(character)) break
      this.advance(1)
    }
    return this.source.slice(start, this.index)
  }

  private codepoint(value: number, body: string, at: Position): string {
    if (!Number.isFinite(value) || value <= 0 || value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff)) {
      this.fail(`character reference "&${body};" is out of range`, at)
    }
    return String.fromCodePoint(value)
  }

  private readEntity(): string {
    const at = this.loc()
    this.advance(1)
    const start = this.index
    while (!this.atEnd() && this.peek() !== ';' && this.index - start <= 12) this.advance(1)
    if (this.peek() !== ';') this.fail('unterminated entity reference', at)
    const body = this.source.slice(start, this.index)
    this.advance(1)
    const named = NAMED_ENTITIES.get(body)
    if (named !== undefined) return named
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const digits = body.slice(2)
      if (!/^[0-9a-fA-F]+$/u.test(digits)) this.fail(`malformed character reference "&${body};"`, at)
      return this.codepoint(Number.parseInt(digits, 16), body, at)
    }
    if (body.startsWith('#')) {
      const digits = body.slice(1)
      if (!/^[0-9]+$/u.test(digits)) this.fail(`malformed character reference "&${body};"`, at)
      return this.codepoint(Number.parseInt(digits, 10), body, at)
    }
    this.fail(`unknown entity "&${body};"; only &amp; &lt; &gt; &quot; &apos; and numeric references are supported`, at)
  }

  private readAttributeValue(quote: string, attribute: string): string {
    const at = this.loc()
    let value = ''
    for (;;) {
      const character = this.peek()
      if (character === undefined) this.fail(`attribute "${attribute}" is not closed`, at)
      if (character === quote) {
        this.advance(1)
        return value
      }
      if (character === '<') this.fail(`"<" is not allowed inside attribute "${attribute}"`)
      if (character === '&') {
        value += this.readEntity()
        continue
      }
      value += character === '\n' || character === '\r' || character === '\t' ? ' ' : character
      this.advance(1)
    }
  }

  private readText(): XmlText {
    const at = this.loc()
    let value = ''
    for (;;) {
      const character = this.peek()
      if (character === undefined || character === '<') break
      if (character === '&') {
        value += this.readEntity()
        continue
      }
      value += character
      this.advance(1)
    }
    return { kind: 'text', value, cdata: false, line: at.line, column: at.column }
  }

  private readCdata(): XmlText {
    const at = this.loc()
    this.advance('<![CDATA['.length)
    const end = this.source.indexOf(']]>', this.index)
    if (end < 0) this.fail('unterminated CDATA section', at)
    const value = this.source.slice(this.index, end)
    while (this.index < end + ']]>'.length) this.advance(1)
    return { kind: 'text', value, cdata: true, line: at.line, column: at.column }
  }

  private parseElement(depth: number): XmlElement {
    const open = this.loc()
    if (depth > MAX_XML_DEPTH) this.fail(`element nesting exceeds ${MAX_XML_DEPTH} levels`, open)
    if (this.peek() !== '<') this.fail('expected "<"')
    this.advance(1)
    const name = this.readName()

    const attributes: XmlAttribute[] = []
    const seen = new Set<string>()
    let selfClosing = false
    for (;;) {
      this.skipWhitespace()
      if (this.startsWith('/>')) {
        this.advance(2)
        selfClosing = true
        break
      }
      const character = this.peek()
      if (character === '>') {
        this.advance(1)
        break
      }
      if (character === undefined) this.fail(`<${name}> is not closed`, open)
      if (character === '<') this.fail(`expected an attribute or ">" inside <${name}>`)
      const attributeAt = this.loc()
      const attributeName = this.readName()
      if (seen.has(attributeName)) this.fail(`duplicate attribute "${attributeName}" on <${name}>`, attributeAt)
      seen.add(attributeName)
      this.skipWhitespace()
      if (this.peek() !== '=') this.fail(`attribute "${attributeName}" must have a value`, attributeAt)
      this.advance(1)
      this.skipWhitespace()
      const quote = this.peek()
      if (quote !== '"' && quote !== "'") this.fail(`attribute "${attributeName}" must be quoted`)
      this.advance(1)
      const value = this.readAttributeValue(quote, attributeName)
      attributes.push({ name: attributeName, value, line: attributeAt.line, column: attributeAt.column })
    }

    const children: XmlNode[] = []
    if (!selfClosing) {
      for (;;) {
        if (this.atEnd()) this.fail(`<${name}> is not closed`, open)
        if (this.startsWith('</')) {
          const close = this.loc()
          this.advance('</'.length)
          const closing = this.readName()
          this.skipWhitespace()
          if (this.peek() !== '>') this.fail(`expected ">" to close </${closing}>`, close)
          this.advance(1)
          if (closing !== name) this.fail(`mismatched closing tag </${closing}>; expected </${name}>`, close)
          break
        }
        if (this.startsWith('<!--')) {
          this.skipComment()
          continue
        }
        if (this.startsWith('<![CDATA[')) {
          if (name !== 'text' && name !== 'tspan') this.fail('CDATA is only allowed inside <text>')
          children.push(this.readCdata())
          continue
        }
        if (this.startsWith('<?')) {
          this.skipInstruction()
          continue
        }
        if (this.peek() === '<') {
          children.push(this.parseElement(depth + 1))
          continue
        }
        children.push(this.readText())
      }
    }

    return { kind: 'element', name, attributes, children, line: open.line, column: open.column }
  }
}

/** Parse one XML document into its root element. Throws `XmlParseError` with line/column. */
export function parseXml(source: string): XmlElement {
  return new Reader(source).parseDocument()
}

/** First attribute with this exact name, or undefined. Namespaces are not resolved. */
export function attributeOf(element: XmlElement, name: string): string | undefined {
  for (const attribute of element.attributes) {
    if (attribute.name === name) return attribute.value
  }
  return undefined
}

/** Element children only (text nodes are dropped). */
export function childElements(element: XmlElement): XmlElement[] {
  return element.children.filter((node): node is XmlElement => node.kind === 'element')
}
