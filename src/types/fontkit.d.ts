declare module 'fontkit' {
  interface FontFace {
    familyName?: string
    postscriptName?: string
    subfamilyName?: string
    characterSet?: number[]
  }
  interface FontCollection {
    fonts: FontFace[]
  }
  export function open(path: string, postscriptName?: string | null): Promise<FontFace | FontCollection>
}
