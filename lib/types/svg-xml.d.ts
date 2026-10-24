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
    readonly name: string;
    readonly value: string;
    readonly line: number;
    readonly column: number;
}
export interface XmlText {
    readonly kind: 'text';
    readonly value: string;
    /** True for `<![CDATA[…]]>` content, which is never entity-decoded. */
    readonly cdata: boolean;
    readonly line: number;
    readonly column: number;
}
export interface XmlElement {
    readonly kind: 'element';
    readonly name: string;
    readonly attributes: readonly XmlAttribute[];
    readonly children: readonly XmlNode[];
    readonly line: number;
    readonly column: number;
}
export type XmlNode = XmlElement | XmlText;
export declare class XmlParseError extends Error {
    readonly line: number;
    readonly column: number;
    constructor(message: string, line: number, column: number);
}
/** Parse one XML document into its root element. Throws `XmlParseError` with line/column. */
export declare function parseXml(source: string): XmlElement;
/** First attribute with this exact name, or undefined. Namespaces are not resolved. */
export declare function attributeOf(element: XmlElement, name: string): string | undefined;
/** Element children only (text nodes are dropped). */
export declare function childElements(element: XmlElement): XmlElement[];
