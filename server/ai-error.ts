export class SafeAIError extends Error {
 shapeIssues?:{path:string[];message:string}[];
 constructor(message:string,readonly code?:'output_length'|'invalid_evidence'){super(message);this.name='AIError';}
}
