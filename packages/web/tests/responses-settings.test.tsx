import {cleanup,fireEvent,render,screen,waitFor}from'@testing-library/react';
import{it,expect,beforeAll,afterEach,vi}from'vitest';
import{PulseDesignSystem}from'../src/PulseDesignSystem.js';import{SettingsPage}from'../src/SettingsPage.js';import{settingsFixture}from'./fixtures/settings.js';
beforeAll(()=>{Object.defineProperty(window,'matchMedia',{value:()=>({matches:false,addEventListener(){},removeEventListener(){}}),configurable:true});const style=window.getComputedStyle.bind(window);window.getComputedStyle=e=>style(e);Element.prototype.scrollTo=vi.fn();vi.stubGlobal('ResizeObserver',class{observe(){}unobserve(){}disconnect(){}})});
afterEach(()=>{cleanup();vi.restoreAllMocks()});
it('preserves the host-only websocket choice in unrelated drafts and clears it on switching out of Responses',async()=>{
 const f=settingsFixture();Object.assign(f.config.providers.sample,{apiMode:'responses',responsesTransport:'websocket'});
 render(<PulseDesignSystem><SettingsPage transport={f.transport}canEditConfig onClose={()=>{}}/></PulseDesignSystem>);
 fireEvent.click(screen.getByRole('button',{name:'模型与服务商',exact:true}));fireEvent.click(await screen.findByRole('button',{name:'编辑服务商 示例服务商'}));
 fireEvent.change(await screen.findByLabelText('显示名称'),{target:{value:'改名服务商'}});fireEvent.click(screen.getByRole('button',{name:'完成编辑'}));
 await waitFor(()=>expect(screen.queryByLabelText('显示名称')).toBeNull());fireEvent.click(screen.getByRole('button',{name:'高级配置',exact:true}));
 expect(JSON.parse((await screen.findByLabelText('完整配置 JSON')as HTMLTextAreaElement).value).providers.sample.responsesTransport).toBe('websocket');
 fireEvent.click(screen.getByRole('button',{name:'模型与服务商',exact:true}));fireEvent.click(await screen.findByRole('button',{name:'编辑服务商 改名服务商'}));
 fireEvent.mouseDown(screen.getByRole('combobox',{name:/^API 格式/}));fireEvent.click(await screen.findByText('Chat Completions（默认）',{selector:'.ant-select-item-option-content'}));fireEvent.click(screen.getByRole('button',{name:'完成编辑'}));
 await waitFor(()=>expect(screen.queryByRole('combobox',{name:/^API 格式/})).toBeNull());fireEvent.click(screen.getByRole('button',{name:'高级配置',exact:true}));
 const profile=JSON.parse((await screen.findByLabelText('完整配置 JSON')as HTMLTextAreaElement).value).providers.sample;expect(profile.apiMode).toBe('chat-completions');expect(profile.responsesTransport).toBeUndefined();expect(f.writes).toEqual([]);
});
