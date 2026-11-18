import ts from 'typescript';
import {z} from 'zod';
import {digest} from './demo-schema';
import type {DemoBusinessContract} from '../shared/generated-demo';

const identifier=z.string().regex(/^[A-Za-z_$][A-Za-z0-9_$]{0,79}$/).refine(value=>!['__proto__','prototype','constructor'].includes(value));
// The model describes data only. It cannot replace executable contract code here.
export const businessFieldAdditionsSchema=z.array(z.object({entity:identifier,name:identifier,type:z.enum(['string','number','boolean'])}).strict()).max(8);
export type BusinessFieldAddition=z.infer<typeof businessFieldAdditionsSchema>[number];
export const businessRuntimeKey=(contract:DemoBusinessContract)=>contract.runtimeKey||digest(contract.source);
const runtime=(source:string)=>ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,removeComments:true}}).outputText;

/** Add optional scalar properties to existing types, leaving initial data and runtime identical. */
export function extendBusinessFields(previous:DemoBusinessContract,raw:unknown):DemoBusinessContract{
 const additions=businessFieldAdditionsSchema.parse(raw),file=ts.createSourceFile('prototype-business.ts',previous.source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
 const edits=new Map<number,string[]>(),seen=new Map<string,string>();
 for(const field of additions){
  const key=field.entity+'.'+field.name,earlier=seen.get(key);if(earlier&&earlier!==field.type)throw Error('新增业务字段类型冲突：'+key);if(earlier)continue;seen.set(key,field.type);
  const declarations=file.statements.filter(node=>(ts.isInterfaceDeclaration(node)||ts.isTypeAliasDeclaration(node))&&node.name.text===field.entity);
  if(declarations.length!==1)throw Error('新增字段必须属于唯一现有业务实体：'+field.entity);
  const declaration=declarations[0] as ts.InterfaceDeclaration|ts.TypeAliasDeclaration;
  if(!declaration.modifiers?.some(m=>m.kind===ts.SyntaxKind.ExportKeyword))throw Error('新增字段必须属于已导出的业务实体');
  const object=ts.isInterfaceDeclaration(declaration)?declaration:ts.isTypeLiteralNode(declaration.type)?declaration.type:undefined;
  if(!object)throw Error('该实体需要整体更新数据定义，不能直接追加字段');
  const member=object.members.find(m=>m.name&&(ts.isIdentifier(m.name)||ts.isStringLiteral(m.name))&&m.name.text===field.name);
  if(member){
   if(ts.isPropertySignature(member)&&member.questionToken&&member.type?.getText(file)===field.type)continue;
   throw Error('不能覆盖或改变已有业务字段：'+key);
  }
  const position=object.end-1;edits.set(position,[...edits.get(position)||[],`  ${field.name}?: ${field.type};`]);
 }
 let source=previous.source;
 for(const [position,lines] of [...edits].sort(([a],[b])=>b-a))source=source.slice(0,position)+'\n'+lines.join('\n')+'\n'+source.slice(position);
 if(source.length>24000)throw Error('共享数据定义过长');
 if(runtime(source)!==runtime(previous.source))throw Error('新增字段不能改变共享数据的运行逻辑');
 return {...previous,source,runtimeKey:businessRuntimeKey(previous)};
}
