(function () {
  "use strict";
  const DEFAULTS = { enabled: true, siteMode: "block", siteList: [], language: "auto", cacheItems: 1, cacheSizeMB: 150 };
  const messages = {
    zh: { title:"逐帧查看器",extensionEnabled:"启用扩展",siteAccess:"网站权限",currentSite:"当前网站",siteMode:"规则模式",blockMode:"除屏蔽列表外均允许（推荐）",allowMode:"仅允许列表中的网站",domainPlaceholder:"输入域名，例如 github.com",add:"添加",noSites:"列表为空",remove:"移除",performance:"缓存与性能",cacheItems:"缓存图片数量",oneRecommended:"1（推荐）",cacheSize:"解码帧缓存上限",mbRecommended:"150 MB（推荐）",language:"界面语言",autoRecommended:"跟随浏览器（推荐）",help:"使用帮助",close:"关闭",helpTitle:"使用帮助",helpIntro:"解析完成后，控制条会显示在动画图片下方并自动播放。",helpSpace:"空格键：播放或暂停。",helpArrows:"左右方向键：逐帧后退或前进。",helpTimeline:"拖动时间条：跳转到指定时间和帧。",helpHold:"长按上一帧或下一帧：连续步进。",helpSite:"遇到网页元素显示异常时，可在此关闭当前网站。",unavailable:"此页面无法设置网站权限",saved:"设置已保存",invalidDomain:"请输入有效域名" },
    en: { title:"Frame Viewer",extensionEnabled:"Enable extension",siteAccess:"Site access",currentSite:"Current site",siteMode:"Rule mode",blockMode:"Allow except blocked sites (Recommended)",allowMode:"Only allow listed sites",domainPlaceholder:"Enter a domain, e.g. github.com",add:"Add",noSites:"The list is empty",remove:"Remove",performance:"Cache & performance",cacheItems:"Cached images",oneRecommended:"1 (Recommended)",cacheSize:"Decoded frame cache limit",mbRecommended:"150 MB (Recommended)",language:"Language",autoRecommended:"Browser language (Recommended)",help:"Help",close:"Close",helpTitle:"Help",helpIntro:"After decoding, controls appear below the animated image and playback starts automatically.",helpSpace:"Space: play or pause.",helpArrows:"Left/Right arrows: step backward or forward.",helpTimeline:"Timeline: seek to a specific time and frame.",helpHold:"Hold Previous or Next: step continuously.",helpSite:"If a page element is affected, disable the extension for the current site here.",unavailable:"Site access is unavailable on this page",saved:"Settings saved",invalidDomain:"Enter a valid domain" }
  };
  const ids = ["enabled","currentSiteEnabled","currentHost","siteMode","domainInput","addDomain","siteList","cacheItems","cacheSizeMB","language","status","helpButton","helpDialog","closeHelp"];
  const el = Object.fromEntries(ids.map((id) => [id, document.getElementById(id)]));
  let settings = { ...DEFAULTS }, currentHost = "", statusTimer;
  function normalizeDomain(value) {
    const text = String(value || "").trim().toLowerCase();
    if (!text) return "";
    if (text === "file://") return text;
    try { return new URL(text.includes("://") ? text : `https://${text}`).hostname.replace(/^www\./, "").replace(/\.$/, ""); } catch { return ""; }
  }
  function normalize(value) {
    return { enabled:value.enabled !== false, siteMode:value.siteMode === "allow" ? "allow" : "block", siteList:Array.isArray(value.siteList) ? [...new Set(value.siteList.map(normalizeDomain).filter(Boolean))] : [], language:["auto","zh","en"].includes(value.language) ? value.language : "auto", cacheItems:[1,2,3].includes(Number(value.cacheItems)) ? Number(value.cacheItems) : 1, cacheSizeMB:[64,150,256,512].includes(Number(value.cacheSizeMB)) ? Number(value.cacheSizeMB) : 150 };
  }
  function language() { return settings.language !== "auto" ? settings.language : (/^zh\b/i.test(chrome.i18n?.getUILanguage?.() || navigator.language || "en") ? "zh" : "en"); }
  function tr(key) { return messages[language()][key] || messages.en[key] || key; }
  function matches(host, rule) { return host === rule || host.endsWith(`.${rule}`); }
  function siteEnabled() { const listed = settings.siteList.some((rule) => matches(currentHost, rule)); return settings.siteMode === "block" ? !listed : listed; }
  function renderList() {
    el.siteList.replaceChildren();
    if (!settings.siteList.length) { const empty=document.createElement("span"); empty.className="site-empty"; empty.textContent=tr("noSites"); el.siteList.append(empty); return; }
    settings.siteList.forEach((domain) => { const row=document.createElement("div"),label=document.createElement("span"),remove=document.createElement("button"); row.className="site-item"; label.textContent=domain; remove.type="button"; remove.textContent="×"; remove.title=tr("remove"); remove.setAttribute("aria-label",`${tr("remove")} ${domain}`); remove.addEventListener("click",()=>{ settings.siteList=settings.siteList.filter((item)=>item!==domain); save(); }); row.append(label,remove); el.siteList.append(row); });
  }
  function render() {
    document.documentElement.lang=language()==="zh"?"zh-CN":"en";
    document.querySelectorAll("[data-i18n]").forEach((node)=>{ node.textContent=tr(node.dataset.i18n); });
    el.enabled.checked=settings.enabled; el.currentHost.textContent=currentHost||"-"; el.currentSiteEnabled.checked=Boolean(currentHost)&&siteEnabled(); el.currentSiteEnabled.disabled=!currentHost||!settings.enabled; el.siteMode.value=settings.siteMode; el.cacheItems.value=String(settings.cacheItems); el.cacheSizeMB.value=String(settings.cacheSizeMB); el.language.value=settings.language; el.domainInput.placeholder=tr("domainPlaceholder"); el.addDomain.title=tr("add"); el.helpButton.title=tr("help"); el.helpButton.setAttribute("aria-label",tr("help")); el.closeHelp.setAttribute("aria-label",tr("close")); renderList();
  }
  function showStatus(message) { clearTimeout(statusTimer); el.status.textContent=message; statusTimer=setTimeout(()=>{el.status.textContent="";},1800); }
  function save(message) { settings=normalize(settings); chrome.storage.sync.set(settings,()=>{render();showStatus(message||tr("saved"));}); }
  function toggleSite() { if(!currentHost)return; const shouldEnable=el.currentSiteEnabled.checked; settings.siteList=settings.siteList.filter((rule)=>!matches(currentHost,rule)); if((settings.siteMode==="block")===!shouldEnable)settings.siteList.push(currentHost); save(); }
  function addDomain() { const domain=normalizeDomain(el.domainInput.value); if(!domain||(!domain.includes(".")&&domain!=="localhost"&&domain!=="file://")){showStatus(tr("invalidDomain"));return;} if(!settings.siteList.includes(domain))settings.siteList.push(domain); el.domainInput.value=""; save(); }
  el.enabled.addEventListener("change",()=>{settings.enabled=el.enabled.checked;save();}); el.currentSiteEnabled.addEventListener("change",toggleSite); el.siteMode.addEventListener("change",()=>{settings.siteMode=el.siteMode.value;save();}); el.cacheItems.addEventListener("change",()=>{settings.cacheItems=Number(el.cacheItems.value);save();}); el.cacheSizeMB.addEventListener("change",()=>{settings.cacheSizeMB=Number(el.cacheSizeMB.value);save();}); el.language.addEventListener("change",()=>{settings.language=el.language.value;save();}); el.addDomain.addEventListener("click",addDomain); el.domainInput.addEventListener("keydown",(event)=>{if(event.key==="Enter")addDomain();}); el.helpButton.addEventListener("click",()=>el.helpDialog.showModal()); el.closeHelp.addEventListener("click",()=>el.helpDialog.close()); el.helpDialog.addEventListener("click",(event)=>{if(event.target===el.helpDialog)el.helpDialog.close();});
  Promise.all([new Promise((resolve)=>chrome.storage.sync.get(DEFAULTS,resolve)),new Promise((resolve)=>chrome.tabs.query({active:true,currentWindow:true},resolve))]).then(([stored,tabs])=>{settings=normalize(stored);try{const pageUrl=new URL(tabs[0]?.url||"");currentHost=pageUrl.protocol==="file:"?"file://":(["http:","https:"].includes(pageUrl.protocol)?normalizeDomain(pageUrl.hostname):"");}catch{currentHost="";}render();if(!currentHost)showStatus(tr("unavailable"));});
})();
