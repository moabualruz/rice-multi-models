import { CLASSIFY_LABELS, CLASSIFY_TEXT_MARK, deriveClassifier } from '../hooks/native-classify.ts'
import { runNative, textOf } from './native-run.ts'

/** Capture only owned marker text against loopback, never an account or a user transcript. */
export async function captureClassifier(signal?: AbortSignal) {
  const source = `export const register=on=>{on('turn.step',async function*($,e){await $.model.classify(${JSON.stringify(CLASSIFY_TEXT_MARK)},${JSON.stringify(CLASSIFY_LABELS)},{model:'haiku'});yield{kind:'text',index:0,text:'OWNED_DONE'};yield{kind:'stop',stopReason:'end_turn',usage:null};return{turnId:e.turnId,index:e.index,answer:'OWNED_DONE',toolUses:[],stopReason:'end_turn',usage:null};});};`
  const run = await runNative({ label: 'classifier', script: ['Owned native classifier contract'], pluginSource: source, answer: () => ({ text: CLASSIFY_LABELS[0] }), signal })
  const requests = run.requests.filter(request => textOf(request.messages && Array.isArray(request.messages) ? request.messages[0]?.content : undefined).includes(CLASSIFY_TEXT_MARK))
  if (requests.length !== 1) throw new Error('The installed host did not expose one native classifier request.')
  const request = requests[0]!
  if (!Array.isArray(request.system) || !Array.isArray(request.messages)) throw new Error('The installed classifier request cannot be read.')
  const system = request.system.map(block => textOf([block])).filter(text => !text.startsWith('x-anthropic-billing-header:')).join('\n\n')
  return deriveClassifier(run.version, system, textOf(request.messages[0]?.content), Number(request.max_tokens))
}
