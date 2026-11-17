export class SafeAIError extends Error {
 shapeIssues?:{path:string[];message:string}[];
 constructor(message:string,readonly code?:'output_length'){super(message);this.name='AIError';}
}
