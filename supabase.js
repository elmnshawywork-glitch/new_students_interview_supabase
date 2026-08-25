/* ============================================================
 *  Supabase adapter — قاعدة البيانات الأساسية (سريعة)
 *  يحلّ محل Apps Script. يطابق نفس أوامر النموذج (actions).
 *  Google Sheet (اختياري) = نسخة احتياطية في الخلفية بدون تأثير على السرعة.
 * ============================================================ */
var SB = (function () {
  var C = window.APP_CONFIG || {};
  var BASE = (C.SUPABASE_URL || "").replace(/\/+$/, "") + "/rest/v1/";
  var KEY = C.SUPABASE_KEY || "";
  function H(extra) {
    return Object.assign({
      "apikey": KEY,
      "Authorization": "Bearer " + KEY,
      "Content-Type": "application/json"
    }, extra || {});
  }
  async function GET(path) {
    var r = await fetch(BASE + path, { headers: H() });
    if (!r.ok) throw new Error("GET " + path + " → " + r.status);
    return r.json();
  }
  async function POST(table, body, prefer) {
    var r = await fetch(BASE + table, { method: "POST", headers: H({ "Prefer": prefer || "return=minimal" }), body: JSON.stringify(body) });
    if (!r.ok) throw new Error("POST " + table + " → " + r.status + " " + (await r.text()).slice(0,200));
    return prefer && /representation/.test(prefer) ? r.json() : true;
  }
  async function PATCH(table, query, body) {
    var r = await fetch(BASE + table + "?" + query, { method: "PATCH", headers: H({ "Prefer": "return=minimal" }), body: JSON.stringify(body) });
    if (!r.ok) throw new Error("PATCH " + table + " → " + r.status);
    return true;
  }
  async function DEL(table, query) {
    var r = await fetch(BASE + table + "?" + query, { method: "DELETE", headers: H() });
    if (!r.ok) throw new Error("DELETE " + table + " → " + r.status);
    return true;
  }
  async function upsert(table, rows, onConflict) {
    return POST(table + "?on_conflict=" + onConflict, rows, "resolution=merge-duplicates,return=minimal");
  }

  // نسخة احتياطية في الخلفية إلى Google Sheet (لا تُنتظر — لا تؤثر على السرعة)
  function mirror(body) {
    var url = (C.SHEET_BACKUP_URL || "").trim();
    if (!url) return;
    try {
      fetch(url, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, body: JSON.stringify(body), keepalive: true }).catch(function(){});
    } catch (e) {}
  }

  /* ---------- تحويل الأعمدة (snake_case ↔ camelCase) ---------- */
  function stuOut(r){ return { nationalId:String(r.national_id), name:r.name||"", school:r.school||"", studentPhone:r.student_phone||"", guardianPhone:r.guardian_phone||"", email:r.email||"", createdAt:r.created_at||"" }; }
  function digits(s){ return String(s==null?"":s).replace(/[^\d]/g,""); }

  var DEFAULTS = {
    unitTotalGrade:"100", unitPassGrade:"50", unitPassMandatory:"false", excelImportEnabled:"true", indicatorMax:"10",
    indicators: JSON.stringify(["الثقة بالنفس ووضوح التعبير والتواصل","الدافعية والميل نحو المجال الفني/التكنولوجي","القدرة على التفكير وحل المشكلات وسرعة البديهة","المظهر العام","قدرة الطالب على التعامل مع التكنولوجيا (حاسب آلي/ذكاء اصطناعي)","العمل ضمن فريق والتواصل مع الآخرين","الالتزام والانضباط وتحمّل المسؤولية","الميول والاستعداد للمجال المهني واليدوي"]),
    weightInterview:"50", weightUnit:"30", weightLang:"20", acceptanceScore:"60",
    schools: JSON.stringify(["مدرسة القاهرة للتكنولوجيا التطبيقية","مدرسة السويس للتكنولوجيا التطبيقية","مدرسة الإسكندرية للتكنولوجيا التطبيقية"]),
    importHeaders: JSON.stringify({ name:"الاسم", nationalId:"الرقم القومي", school:"المدرسة", studentPhone:"موبايل الطالب", guardianPhone:"موبايل ولي الأمر", email:"الايميل" }),
    voiceEn:"", voiceAr:"", sentenceGap:"3", indicatorWeights:"", evaluatorWeights:""
  };

  async function getConfig() {
    var rows = await GET("config?select=key,value");
    var cfg = {}; rows.forEach(function(r){ cfg[r.key] = String(r.value); });
    Object.keys(DEFAULTS).forEach(function(k){ if(!(k in cfg)) cfg[k]=DEFAULTS[k]; });
    return cfg;
  }

  function r1(x){ return x===null||x===undefined?null:Math.round(x*10)/10; }

  // حساب نتيجة طالب (يطابق منطق الخادم: أوزان مؤشرات/مقيّمين + منح إعادة)
  function computeResult(nid, ctx, cfg) {
    nid=String(nid);
    var iMax=Number(cfg.indicatorMax)||10;
    var indW=[]; try{indW=JSON.parse(cfg.indicatorWeights);}catch(e){}
    var evW={}; try{evW=JSON.parse(cfg.evaluatorWeights)||{};}catch(e){}
    var ivs=ctx.interviews.filter(function(x){return String(x.national_id)===nid;});
    var interviewPct=null;
    if(ivs.length){
      var wsum=0,wtot=0;
      ivs.forEach(function(v){
        var arr=v.scores; if(typeof arr==="string"){try{arr=JSON.parse(arr);}catch(e){arr=[];}} arr=arr||[];
        var s=0,w=0;
        arr.forEach(function(sc,i){ var iw=(indW[i]!=null&&indW[i]!=="")?Number(indW[i]):1; s+=(Number(sc)||0)*iw; w+=iw; });
        var pct=w?(s/w)/iMax*100:(Number(v.avg)/iMax*100);
        var ew=(evW[v.evaluator]!=null&&evW[v.evaluator]!=="")?Number(evW[v.evaluator]):1;
        wsum+=pct*ew; wtot+=ew;
      });
      interviewPct=wtot?wsum/wtot:null;
    }
    var ug=ctx.unit.filter(function(x){return String(x.national_id)===nid;})[0];
    var unitGrade=ug?Number(ug.grade):null;
    var unitTotal=Number(cfg.unitTotalGrade)||100;
    var unitPct=unitGrade===null?null:(unitGrade/unitTotal)*100;
    var lang=ctx.lang.filter(function(x){return String(x.national_id)===nid;})[0];
    var langPct=lang?Number(lang.lang_total):null;
    var langDetail=lang?{enListen:Number(lang.en_listen),translate:Number(lang.translate),arListen:Number(lang.ar_listen)}:null;
    var langDate=lang&&lang.created_at?new Date(lang.created_at).toISOString():null;
    var wI=Number(cfg.weightInterview)||50, wU=Number(cfg.weightUnit)||30, wL=Number(cfg.weightLang)||20;
    var final=0, missing=[];
    final+=((interviewPct===null?0:interviewPct)/100)*wI; if(interviewPct===null) missing.push("المقابلة");
    final+=((unitPct===null?0:unitPct)/100)*wU; if(unitPct===null) missing.push("امتحان الوحدة");
    final+=((langPct===null?0:langPct)/100)*wL; if(langPct===null) missing.push("الامتحان اللغوي");
    var acc=Number(cfg.acceptanceScore)||0;
    var retake=ctx.retakes.some(function(x){return String(x.national_id)===nid;});
    return { nationalId:nid, interviewPct:r1(interviewPct), unitPct:r1(unitPct), langPct:r1(langPct),
      unitGrade:unitGrade, langDetail:langDetail, langDate:langDate, weights:{interview:wI,unit:wU,lang:wL},
      finalScore:r1(final), complete:missing.length===0, missing:missing, evaluatorsCount:ivs.length,
      acceptanceScore:acc, accepted:r1(final)>=acc, retakeGranted:retake,
      evaluators: ivs.map(function(v){return v.evaluator;}),
      interviewNotes: ivs.filter(function(v){return v.notes;}).map(function(v){return {evaluator:v.evaluator, role:v.role, notes:v.notes};}) };
  }

  async function loadCtx() {
    var res = await Promise.all([
      GET("students?select=*&order=created_at.asc"),
      GET("unit_grades?select=*"),
      GET("lang_results?select=*"),
      GET("interviews?select=*"),
      GET("retakes?select=*"),
      getConfig()
    ]);
    return { students:res[0], unit:res[1], lang:res[2], interviews:res[3], retakes:res[4], config:res[5] };
  }

  var ok=function(o){ return Object.assign({ok:true},o||{}); };
  var err=function(m){ return {ok:false,error:m}; };

  async function handle(body) {
    var a = body.action;
    try {
      switch (a) {
        case "login": {
          var u=await GET("users?select=*&username=eq."+encodeURIComponent(body.username)+"&password=eq."+encodeURIComponent(body.password));
          if(!u.length) return err("اسم المستخدم أو كلمة المرور غير صحيحة");
          return ok({user:{username:u[0].username,name:u[0].name,role:u[0].role}});
        }
        case "getConfig": return ok({config: await getConfig()});
        case "setConfig": {
          var upd=body.config||{}; var rows=Object.keys(upd).map(function(k){return {key:k,value:String(upd[k])};});
          if(rows.length) await upsert("config", rows, "key");
          mirror(body); return ok({config: await getConfig()});
        }
        case "listUsers": {
          var us=await GET("users?select=username,name,role"); return ok({users:us});
        }
        case "createUser": {
          await POST("users",[{username:body.newUsername,password:body.newPassword,name:body.name||body.newUsername,role:body.role||"committee"}]);
          mirror(body); return ok();
        }
        case "deleteUser": {
          if(body.target==="admin") return err("لا يمكن حذف حساب المدير الأساسي");
          await DEL("users","username=eq."+encodeURIComponent(body.target)); mirror(body); return ok();
        }
        case "listStudents": {
          var s=await GET("students?select=*&order=created_at.asc"); return ok({students:s.map(stuOut)});
        }
        case "getStudent": {
          var g=await GET("students?select=*&national_id=eq."+digits(body.nationalId));
          return g.length?ok({student:stuOut(g[0])}):err("الطالب غير مسجّل");
        }
        case "registerStudent": {
          var st=body.student||{}; var nid=digits(st.nationalId);
          if(!/^\d{6,20}$/.test(nid)) return err("الرقم القومي غير صحيح");
          if(!st.name) return err("الاسم مطلوب");
          await upsert("students",[{national_id:nid,name:st.name,school:st.school||"",student_phone:st.studentPhone||"",guardian_phone:st.guardianPhone||"",email:st.email||""}],"national_id");
          mirror(body); return ok({student:{nationalId:nid,name:st.name}});
        }
        case "importStudents": {
          var rows=body.rows||[], srows=[], grows=[], added=0, skipped=0, seen={};
          rows.forEach(function(s){
            var nid=digits(s.nationalId); if(!/^\d{6,20}$/.test(nid)||!s.name){skipped++;return;}
            if(seen[nid]) return; seen[nid]=1;
            srows.push({national_id:nid,name:String(s.name).trim(),school:s.school||"",student_phone:s.studentPhone||"",guardian_phone:s.guardianPhone||"",email:s.email||""}); added++;
            if(s.unitGrade!==""&&s.unitGrade!=null&&!isNaN(Number(s.unitGrade))) grows.push({national_id:nid,name:String(s.name).trim(),grade:Number(s.unitGrade)});
          });
          if(srows.length) await upsert("students",srows,"national_id");
          if(grows.length) await upsert("unit_grades",grows,"national_id");
          mirror(body); return ok({added:added,updated:0,skipped:skipped,grades:grows.length});
        }
        case "setUnitGrade": {
          await upsert("unit_grades",[{national_id:digits(body.nationalId),name:body.name||"",grade:Number(body.grade)||0}],"national_id");
          mirror(body); return ok();
        }
        case "importUnitGrades": {
          var students=await GET("students?select=national_id,name");
          var byName={}; students.forEach(function(s){ byName[normName(s.name)]=String(s.national_id); });
          var grows2=[], linked=0, skipped2=0, seen2={};
          (body.rows||[]).forEach(function(r){
            var nid=digits(r.nationalId);
            if(!/^\d{6,20}$/.test(nid)&&r.name){ nid=byName[normName(r.name)]||""; }
            if(!nid){skipped2++;return;}
            if(seen2[nid]) return; seen2[nid]=1;
            grows2.push({national_id:nid,name:r.name||"",grade:Number(r.grade)||0}); linked++;
          });
          if(grows2.length) await upsert("unit_grades",grows2,"national_id");
          mirror(body); return ok({linked:linked,skipped:skipped2});
        }
        case "studentBegin": {
          var nidb=digits(body.nationalId);
          var sb=await GET("students?select=name,school,national_id&national_id=eq."+nidb);
          if(!sb.length) return err("الطالب غير مسجّل");
          var lr=await GET("lang_results?select=national_id&national_id=eq."+nidb);
          return ok({student:{nationalId:nidb,name:sb[0].name,school:sb[0].school},alreadyDone:lr.length>0});
        }
        case "submitLang": {
          var sc=body.scores||{};
          await upsert("lang_results",[{national_id:digits(body.nationalId),en_listen:Number(sc.enListen)||0,translate:Number(sc.translate)||0,ar_listen:Number(sc.arListen)||0,lang_total:Number(sc.langTotal)||0,feedback:body.feedback||"auto",answers:body.answers||{}}],"national_id");
          mirror(body); return ok();
        }
        case "getPassages": return ok({passages: window.PASSAGE_BANK||window.PASSAGES||[]});
        case "regradeAll": return err("إعادة التصحيح بالذكاء الاصطناعي تتطلب خادمًا (غير متاح في وضع Supabase المباشر).");
        case "resetLangExam": {
          var nidr=digits(body.nationalId);
          await DEL("lang_results","national_id=eq."+nidr);
          await upsert("retakes",[{national_id:nidr,by_user:body.username||"admin"}],"national_id");
          mirror(body); return ok();
        }
        case "getLangAnswers": {
          var ng=digits(body.nationalId);
          var lrg=await GET("lang_results?select=*&national_id=eq."+ng);
          if(!lrg.length) return err("لا توجد نتيجة امتحان لغوي لهذا الطالب");
          var sg=await GET("students?select=name,school&national_id=eq."+ng);
          var ans=lrg[0].answers; if(typeof ans==="string"){try{ans=JSON.parse(ans);}catch(e){ans={};}}
          return ok({student:{nationalId:ng,name:(sg[0]||{}).name||"",school:(sg[0]||{}).school||""},answers:ans||{},langTotal:Number(lrg[0].lang_total)||0,timestamp:lrg[0].created_at});
        }
        case "submitInterview": {
          var scores=body.scores||[]; var sum=0; scores.forEach(function(n){sum+=Number(n)||0;});
          var avg=scores.length?sum/scores.length:0;
          await upsert("interviews",[{national_id:digits(body.nationalId),evaluator:body.evaluator,role:body.role||"",scores:scores,avg:avg,notes:body.notes||""}],"national_id,evaluator");
          mirror(body); return ok();
        }
        case "deleteStudents": {
          var ids=(body.nationalIds||[]).map(digits).filter(Boolean);
          if(!ids.length) return err("لم يتم تحديد طلاب");
          var inlist="("+ids.map(function(x){return '"'+x+'"';}).join(",")+")";
          // الحذف المتسلسل (cascade) يمسح الوحدة/اللغوي/المقابلة/الإعادة تلقائيًا
          await DEL("students","national_id=in."+inlist);
          mirror(body); return ok({deleted:ids.length});
        }
        case "setLangResult": {
          var sc2=body.scores||{};
          await upsert("lang_results",[{national_id:digits(body.nationalId),en_listen:Number(sc2.enListen)||0,translate:Number(sc2.translate)||0,ar_listen:Number(sc2.arListen)||0,lang_total:Number(sc2.langTotal)||0,feedback:body.feedback||"manual",answers:body.answers||{}}],"national_id");
          mirror(body); return ok();
        }
        case "getResult": {
          var ctx1=await loadCtx();
          var s1=ctx1.students.filter(function(x){return String(x.national_id)===digits(body.nationalId);})[0];
          if(!s1) return err("الطالب غير مسجّل");
          var r=computeResult(body.nationalId,ctx1,ctx1.config); r.name=s1.name;
          return ok({result:r});
        }
        case "listResults": {
          var ctx2=await loadCtx();
          return ok({results: ctx2.students.map(function(s){ var r=computeResult(s.national_id,ctx2,ctx2.config); r.name=s.name; return r; })});
        }
        case "bootstrap": {
          var ctx3=await loadCtx();
          var rows3=ctx3.students.map(function(s){
            var r=computeResult(s.national_id,ctx3,ctx3.config);
            r.name=s.name; r.school=s.school||""; r.studentPhone=s.student_phone||""; r.guardianPhone=s.guardian_phone||""; r.email=s.email||""; r.createdAt=s.created_at||"";
            return r;
          });
          return ok({config:ctx3.config, rows:rows3});
        }
        case "exportResultsSheet":
          // البيانات محفوظة في Supabase؛ النسخ الاحتياطي يتم في الخلفية مع كل كتابة.
          return ok({skipped:true});
        default: return err("إجراء غير معروف: "+a);
      }
    } catch (e) {
      return err("خطأ في قاعدة البيانات: " + (e && e.message ? e.message : e));
    }
  }

  function normName(s){ return String(s||"").replace(/[\u064B-\u0652]/g,"").replace(/[إأآٱ]/g,"ا").replace(/ى/g,"ي").replace(/ة/g,"ه").replace(/ؤ/g,"و").replace(/ئ/g,"ي").replace(/\s+/g," ").trim(); }

  return { handle: handle, active: function(){ return !!(C.SUPABASE_URL && C.SUPABASE_KEY); } };
})();
