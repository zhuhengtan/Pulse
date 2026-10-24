import {expect,it} from 'vitest'
// @ts-expect-error evaluator is intentionally standalone JavaScript
import {nativePreferenceConfirmation,nativeProfileConfirmation} from '../scripts/eval/autonomy-native-ui.mjs'
const url='http://127.0.0.1:12345'
const native='\t3 HTML 内容 Pulse Preferences Acceptance, URL: 127.0.0.1:12345/\n\t\t4 文本栏 (settable) 显示名, Value: Pulse界面复核\n\t\t5 复选框 Description: 显示摘要, Value: 1\n\t\t6 文本 已应用：Pulse界面复核；摘要：开启\n\t7 关闭按钮'
it('requires the actual fixture subtree and matching control states, not quoted model text',()=>{
 expect(nativePreferenceConfirmation(native,url)).toBe(true)
 expect(nativePreferenceConfirmation(native.replace('Value: 1','Value: 0'),url)).toBe(false)
 expect(nativePreferenceConfirmation(native,'http://127.0.0.1:12346')).toBe(false)
 expect(nativePreferenceConfirmation('1 text '+native.replaceAll('\n',' '),url)).toBe(false)
 expect(nativePreferenceConfirmation(native.replace('\t\t6 文本 已应用：Pulse界面复核；摘要：开启','')+'\n8 text 已应用：Pulse界面复核；摘要：开启',url)).toBe(false)
})

it('verifies the original Name/Save case only from its native page subtree',()=>{
 const profile='\t3 HTML 内容 Pulse Browser Acceptance, URL: 127.0.0.1:12345/\n\t\t4 文本栏 (settable) Name, Value: Pulse自主验收\n\t\t5 文本 Saved: Pulse自主验收\n\t6 按钮 关闭'
 expect(nativeProfileConfirmation(profile,url)).toBe(true)
 expect(nativeProfileConfirmation(profile,'http://127.0.0.1:12346')).toBe(false)
 expect(nativeProfileConfirmation(profile.replace('\t\t5 文本 Saved: Pulse自主验收','')+'\n7 text Saved: Pulse自主验收',url)).toBe(false)
 expect(nativeProfileConfirmation('1 text '+profile.replaceAll('\n',' '),url)).toBe(false)
})
