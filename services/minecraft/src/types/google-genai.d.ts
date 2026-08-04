declare module '@google/genai' {
  export class GoogleGenAI {
    constructor(options: Record<string, unknown>)
    live: {
      connect: (options: Record<string, unknown>) => Promise<any>
    }
  }
}
