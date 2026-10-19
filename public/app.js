import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.0";
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from "/config.js";

const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
const $ = (s) => document.querySelector(s);
const authPanel=$("#authPanel"), appPanel=$("#appPanel"), authForm=$("#authForm");
let authMode="signin", currentUser=null, activeConversationId=null, activeCategory="solve", busy=false;

function setAuthMode(mode){
  authMode=mode;
  const signup=mode==="signup";
  $("#authHeading").textContent=signup?"Create your study account.":"Your next breakthrough starts here.";
  $("#nameLabel").classList.toggle("hidden",!signup); $("#displayName").classList.toggle("hidden",!signup);
  $("#displayName").required=signup;
  $("#password").autocomplete=signup?"new-password":"current-password";
  $("#authBtn").innerHTML=signup?"Create account <span>↗</span>":"Sign in <span>↗</span>";
  $("#switchText").textContent=signup?"Already have an account?":"New to Ask Me.ai?";
  $("#switchMode").textContent=signup?"Sign in":"Create account";
  $("#authStatus").textContent="";
}
$("#switchMode").addEventListener("click",()=>setAuthMode(authMode==="signin"?"signup":"signin"));

authForm.addEventListener("submit",async(e)=>{
  e.preventDefault(); const btn=$("#authBtn"); btn.disabled=true; $("#authStatus").textContent="Connecting securely…";
  const email=$("#email").value.trim(), password=$("#password").value;
  try{
    if(authMode==="signup"){
      const {data,error}=await supabase.auth.signUp({email,password,options:{data:{display_name:$("#displayName").value.trim()}}});
      if(error) throw error;
      if(data.session && data.user){
        await supabase.from("profiles").upsert({id:data.user.id,display_name:$("#displayName").value.trim()},{onConflict:"id"});
        await showApp(data.user);
      }else{$("#authStatus").textContent="Account created. Check your email to confirm your account, then sign in.";}
    }else{
      const {data,error}=await supabase.auth.signInWithPassword({email,password}); if(error) throw error; await showApp(data.user);
    }
  }catch(err){$("#authStatus").textContent=err.message||"Unable to authenticate. Please try again.";}
  finally{btn.disabled=false;}
});

$("#signOutBtn").addEventListener("click",async()=>{await supabase.auth.signOut(); currentUser=null; activeConversationId=null; appPanel.classList.add("hidden");authPanel.classList.remove("hidden");$("#signOutBtn").classList.add("hidden");$("#userLabel").textContent="";setAuthMode("signin");});
$("#newChatBtn").addEventListener("click",()=>{activeConversationId=null;$("#thread").innerHTML='<div class="welcome-card"><div class="welcome-icon">✦</div><h3>What are we learning today?</h3><p>Ask a question, paste a maths problem or tell me what topic is giving you trouble.</p></div>';$("#prompt").focus();});
document.querySelectorAll(".quick").forEach(btn=>btn.addEventListener("click",()=>{document.querySelectorAll(".quick").forEach(b=>b.classList.remove("active"));btn.classList.add("active");activeCategory=btn.dataset.category;$("#prompt").value=btn.dataset.prompt;$("#prompt").focus();}));

function escapeHtml(value){return String(value).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}
function addMessage(role,content,model=""){
  const thread=$("#thread"); const empty=thread.querySelector(".welcome-card"); if(empty) empty.remove();
  const node=document.createElement("article"); node.className="message "+role;
  node.innerHTML='<div class="message-role">'+(role==="user"?"YOU":"✦ ASK ME.AI")+'</div><div class="message-content">'+escapeHtml(content).replace(/\n/g,"<br>")+'</div>'+(model?'<div class="message-model">'+escapeHtml(model)+'</div>':"");
  thread.append(node); node.scrollIntoView({behavior:"smooth",block:"nearest"});
}
async function loadHistory(){
  const {data,error}=await supabase.from("conversations").select("id,title,category,updated_at").eq("user_id",currentUser.id).order("updated_at",{ascending:false}).limit(30);
  const list=$("#historyList"); list.innerHTML="";
  if(error){list.innerHTML='<p class="muted small">Could not load your history.</p>';return;}
  if(!data?.length){list.innerHTML='<p class="muted small">Your saved conversations will appear here.</p>';return;}
  data.forEach(item=>{const b=document.createElement("button");b.className="history-item"+(item.id===activeConversationId?" selected":"");b.type="button";b.textContent=item.title||"New conversation";b.addEventListener("click",()=>openConversation(item.id));list.append(b);});
}
async function openConversation(id){
  activeConversationId=id; const {data,error}=await supabase.from("messages").select("role,content,model,created_at").eq("conversation_id",id).eq("user_id",currentUser.id).order("created_at",{ascending:true});
  if(error){$("#status").textContent="Could not open this conversation.";return;}
  $("#thread").innerHTML=""; (data||[]).forEach(m=>addMessage(m.role,m.content,m.model||"")); await loadHistory();
}
async function showApp(user){
  currentUser=user;authPanel.classList.add("hidden");appPanel.classList.remove("hidden");$("#signOutBtn").classList.remove("hidden");$("#userLabel").textContent=user.email||"Signed in";
  const displayName=user.user_metadata?.display_name||user.email?.split("@")[0]||"Student";
  const profile=await supabase.from("profiles").upsert({id:user.id,display_name:displayName},{onConflict:"id"});
  if(profile.error) console.warn("Profile sync:",profile.error.message);
  await loadHistory();
}
async function ask(){
  if(busy)return; const prompt=$("#prompt").value.trim(); if(prompt.length<2){$("#status").textContent="Type a question first.";return;}
  busy=true;const btn=$("#askBtn");btn.disabled=true;btn.innerHTML="Thinking…";$("#status").textContent="Working on your answer…";
  addMessage("user",prompt);$("#prompt").value="";
  try{
    if(!activeConversationId){
      const title=prompt.replace(/\s+/g," ").slice(0,70);
      const {data,error}=await supabase.from("conversations").insert({user_id:currentUser.id,title,category:activeCategory}).select("id").single();
      if(error)throw error;activeConversationId=data.id;
    }
    const userSave=await supabase.from("messages").insert({conversation_id:activeConversationId,user_id:currentUser.id,role:"user",content:prompt});
    if(userSave.error)throw userSave.error;
    const {data,error}=await supabase.functions.invoke("ask",{body:{prompt,category:activeCategory}});
    if(error)throw error; if(data?.error)throw new Error(data.error); if(!data?.answer)throw new Error("The AI returned no answer.");
    addMessage("assistant",data.answer,data.model||"Ask Me.ai");
    const saved=await supabase.from("messages").insert({conversation_id:activeConversationId,user_id:currentUser.id,role:"assistant",content:data.answer,model:data.model||null});
    if(saved.error)throw saved.error;
    await supabase.from("conversations").update({updated_at:new Date().toISOString()}).eq("id",activeConversationId).eq("user_id",currentUser.id);
    $("#status").textContent="Answer saved to your library.";await loadHistory();
  }catch(err){
    let message=err?.message||"Something went wrong. Please try again.";
    if(err?.context && typeof err.context.clone==="function"){
      const detail=await err.context.clone().json().catch(()=>null);
      if(detail?.error) message=detail.error;
    }
    $("#status").textContent=message;
    addMessage("assistant",message);
  }
  finally{busy=false;btn.disabled=false;btn.innerHTML='Ask AI <span>↗</span>';}
}
$("#askBtn").addEventListener("click",ask);
$("#prompt").addEventListener("keydown",e=>{if(e.key==="Enter"&&(e.ctrlKey||e.metaKey)){e.preventDefault();ask();}});
async function init(){
  const {data:{session}}=await supabase.auth.getSession();
  if(session?.user)await showApp(session.user);
  supabase.auth.onAuthStateChange((event)=>{if(event==="SIGNED_OUT"){currentUser=null;activeConversationId=null;appPanel.classList.add("hidden");authPanel.classList.remove("hidden");$("#signOutBtn").classList.add("hidden");$("#userLabel").textContent="";}});
}
init();