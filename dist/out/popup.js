var s=document.getElementById("title-input"),o=document.getElementById("author-input"),t=document.getElementById("submit"),r=document.getElementById("error");t.addEventListener("click",()=>{t.disabled=!0,r.innerText="",browser.tabs.query({active:!0,currentWindow:!0}).then(async([e])=>{try{let n={tabId:e.id,title:s.value.trim()||void 0,author:o.value.trim()||void 0};await browser.runtime.sendMessage(n),window.close()}finally{t.disabled=!1}},(e)=>{let n=e instanceof Error?e.message:"unknown error";r.innerText=`error getting tab: ${n}`,t.disabled=!1})});

//# debugId=EADF37F7332451FC64756E2164756E21
//# sourceMappingURL=popup.js.map
