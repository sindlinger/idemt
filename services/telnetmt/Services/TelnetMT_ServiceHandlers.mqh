// BridgeHandlers.mqh
// Utilidades + handlers + Dispatch, sem OnStart (para ser usado por pipe e socket)
#ifndef __BRIDGE_HANDLERS_MQH__
#define __BRIDGE_HANDLERS_MQH__

string LISTENER_VERSION = "bridge-1.0.4-true-resp";

#include <Trade\\Trade.mqh>
#include <Trade\\PositionInfo.mqh>
#include <Files\\File.mqh>
#include "TelnetMT_Mql5Diag.mqh"
#include "TelnetMT_SvcErrors.mqh"
#include "TelnetMT_ScriptActions.mqh"

string PayloadGet(const string payload, const string key)
{
  if(payload=="") return "";
  string parts[]; int n=StringSplit(payload, ';', parts);
  for(int i=0;i<n;i++)
  {
    string kv[]; int c=StringSplit(parts[i], '=', kv);
    if(c==2 && kv[0]==key) return kv[1];
  }
  return "";
}

// Armazena ultimo attach para inputs simples (compat com listener)
string g_lastIndName = "";
string g_lastIndParams = ""; // k=v;k2=v2
string g_lastIndSymbol = "";
string g_lastIndTf = "";
int    g_lastIndSub = 1;
int    g_lastIndHandle = INVALID_HANDLE;
string g_lastIndChartName = "";

string g_lastEAName = "";
string g_lastEAParams = "";
string g_lastEASymbol = "";
string g_lastEATf = "";
string g_lastEATpl = "";

// log tracking
string g_log_date = "";
long   g_log_pos  = 0;

ENUM_TIMEFRAMES TfFromString(string &tf)
{
  string u=tf; StringToUpper(u);
  if(u=="M1") return PERIOD_M1;
  if(u=="M5") return PERIOD_M5;
  if(u=="M15") return PERIOD_M15;
  if(u=="M30") return PERIOD_M30;
  if(u=="H1") return PERIOD_H1;
  if(u=="H4") return PERIOD_H4;
  if(u=="D1") return PERIOD_D1;
  if(u=="W1") return PERIOD_W1;
  if(u=="MN1") return PERIOD_MN1;
  return (ENUM_TIMEFRAMES)0;
}

int SubwindowSafe(string &val)
{
  if(val=="") return 1;
  int v=(int)StringToInteger(val);
  return (v<=0)?1:v;
}

long FindChartBySymbolTf(const string sym, ENUM_TIMEFRAMES tf)
{
  long id=ChartFirst();
  while(id>=0)
  {
    if((string)ChartSymbol(id)==sym && (ENUM_TIMEFRAMES)ChartPeriod(id)==tf) return id;
    id=ChartNext(id);
  }
  return 0;
}

int ParseParams(string &pstr, string &keys[], string &vals[])
{
  if(pstr=="") { ArrayResize(keys,0); ArrayResize(vals,0); return 0; }
  string pairs[]; int n=StringSplit(pstr, ';', pairs);
  int count=0;
  ArrayResize(keys, n); ArrayResize(vals, n);
  for(int i=0;i<n;i++)
  {
    if(pairs[i]=="") continue;
    string kv[]; int c=StringSplit(pairs[i], '=', kv);
    if(c==2)
    {
      string k=kv[0]; string v=kv[1];
      StringTrimLeft(k); StringTrimRight(k);
      StringTrimLeft(v); StringTrimRight(v);
      keys[count]=k; vals[count]=v;
      count++;
    }
    else
    {
      // permite lista simples (sem chave)
      string v=pairs[i];
      StringTrimLeft(v); StringTrimRight(v);
      keys[count]=""; vals[count]=v;
      count++;
    }
  }
  ArrayResize(keys, count); ArrayResize(vals, count);
  return count;
}

int BuildParams(string &pstr, MqlParam &outParams[])
{
  string ks[], vs[]; int cnt=ParseParams(pstr, ks, vs);
  ArrayResize(outParams, cnt);
  for(int i=0;i<cnt;i++)
  {
    double num = StringToDouble(vs[i]);
    if((StringLen(vs[i])>0 && num!=0) || vs[i]=="0")
    {
      outParams[i].type = TYPE_DOUBLE;
      outParams[i].double_value = num;
    }
    else
    {
      outParams[i].type = TYPE_STRING;
      outParams[i].string_value = vs[i];
    }
  }
  return cnt;
}

bool EnsureSymbol(string &sym)
{
  // Não bloqueia por símbolo; deixa o MT5 resolver no ChartOpen/iCustom
  return true;
}

string NormalizeTfString(const string tf)
{
  if(StringFind(tf, "PERIOD_")==0) return StringSubstr(tf, 7);
  return tf;
}

bool UseChartDefaults(string &sym, string &tfstr)
{
  long cid = ChartFirst();
  if(cid<0) return false;
  string cs = ChartSymbol(cid);
  ENUM_TIMEFRAMES ctf = (ENUM_TIMEFRAMES)ChartPeriod(cid);
  if(cs=="") return false;
  sym = cs;
  tfstr = NormalizeTfString(EnumToString(ctf));
  return true;
}

string Join(string &arr[], const string sep)
{
  string out="";
  int n=ArraySize(arr);
  for(int i=0;i<n;i++)
  {
    if(i>0) out+=sep;
    out+=arr[i];
  }
  return out;
}

string ErrFmt(const string where, const int code=-1, const string extra="")
{
  string s="ERR "+where;
  if(code>=0) s += " code="+IntegerToString(code)+" ("+Diag_ErrorText(code)+")";
  if(extra!="") s += " | "+extra;
  return s;
}

string ErrFmtCodeDesc(const string where, const long code, const string desc, const string extra="")
{
  string s="ERR "+where+" code="+IntegerToString(code)+" ("+desc+")";
  if(extra!="") s += " | "+extra;
  return s;
}

bool FailMsg(string &m, const string where, const string extra="")
{
  m = ErrFmt(where, -1, extra);
  return false;
}

bool FailLast(string &m, const string where, const string extra="")
{
  int err = GetLastError();
  if(extra!="")
    PrintFormat("[Diag] %s | %s: err=%d (%s)", where, extra, err, Diag_ErrorText(err));
  else
    PrintFormat("[Diag] %s: err=%d (%s)", where, err, Diag_ErrorText(err));
  m = ErrFmt(where, err, extra);
  ResetLastError();
  return false;
}

string FilesDir()
{
  static string dir="";
  if(dir=="")
    dir = TerminalInfoString(TERMINAL_DATA_PATH) + "\\MQL5\\Files";
  return dir;
}

string SnapshotFolderRel()
{
  return "MQL5\\Profiles\\Templates\\snapshots";
}

bool EnsureSnapshotFolder()
{
  string folder = SnapshotFolderRel();
  if(FolderCreate(folder)) return true;
  if(FileIsExist(folder)) return true;
  return false;
}

string TemplatesRel()
{
  return "MQL5\\Profiles\\Templates";
}

string TemplatesAbs()
{
  return TerminalInfoString(TERMINAL_DATA_PATH) + "\\MQL5\\Profiles\\Templates";
}

string EnsureTplExt(string name)
{
  if(StringLen(name)>=4)
  {
    string tail=StringSubstr(name, StringLen(name)-4);
    if(StringCompare(tail, ".tpl", false)==0) return name;
  }
  return name + ".tpl";
}

string ExpertBaseName(string expert)
{
  string e=expert;
  StringReplace(e, "/", "\\");
  string parts[]; int n=StringSplit(e, '\\', parts);
  if(n>0) e=parts[n-1];
  if(StringLen(e)>4)
  {
    string tail=StringSubstr(e, StringLen(e)-4);
    if(tail==".mq5" || tail==".ex5") e=StringSubstr(e,0,StringLen(e)-4);
  }
  return e;
}

string TplNameFromExpert(string expert)
{
  string base=ExpertBaseName(expert);
  return EnsureTplExt(base);
}

long FindChartBySymbolTF(const string sym, const ENUM_TIMEFRAMES tf)
{
  long id=ChartFirst();
  while(id>=0)
  {
    if(ChartSymbol(id)==sym && ChartPeriod(id)==tf) return id;
    id=ChartNext(id);
  }
  return 0;
}

string ChooseBaseTemplate()
{
  if(FileIsExist(TemplatesAbs()+"\\Moving Average.tpl")) return "Moving Average.tpl";
  if(FileIsExist(TemplatesAbs()+"\\Default.tpl")) return "Default.tpl";
  if(FileIsExist(TemplatesAbs()+"\\default.tpl")) return "default.tpl";
  return "";
}

bool EnsureStubTemplate(const long cid, const string stubName, const string baseTplParam, string &err)
{
  string stub=EnsureTplExt(stubName==""?"Stub.tpl":stubName);
  string stubPath=TemplatesAbs()+"\\"+stub;
  if(FileIsExist(stubPath)) return true;

  string baseTpl=baseTplParam;
  if(baseTpl=="" || StringCompare(baseTpl, stub, false)==0) baseTpl=ChooseBaseTemplate();
  if(baseTpl!="") baseTpl=EnsureTplExt(baseTpl);

  string txt=""; bool is_unicode=false;
  if(baseTpl!="")
  {
    string basePath=TemplatesAbs()+"\\"+baseTpl;
    ReadFileText(basePath, txt, is_unicode);
  }
  if(txt=="")
  {
    // fallback: salva template do chart atual e usa como base
    if(cid<=0) { err="stub_no_chart"; return false; }
    string tmpName="__cmdmt_stub_src";
    if(!ChartSaveTemplate(cid, tmpName)) { err="stub_save_fail"; return false; }
    string tmpPath=TemplatesAbs()+"\\"+tmpName+".tpl";
    if(!ReadFileText(tmpPath, txt, is_unicode)) { err="stub_read_fail"; return false; }
    FileDelete(tmpPath);
  }
  txt=StripExpertBlock(txt);
  if(!WriteFileText(stubPath, txt, is_unicode)) { err="stub_write_fail"; return false; }
  return true;
}

bool ReadFileText(const string path, string &out, bool &is_unicode)
{
  out=""; is_unicode=false;
  int h=FileOpen(path, FILE_READ|FILE_TXT|FILE_UNICODE);
  if(h!=INVALID_HANDLE)
  {
    while(!FileIsEnding(h))
    {
      string line=FileReadString(h);
      out += line;
      if(!FileIsEnding(h)) out += "\n";
    }
    FileClose(h);
    is_unicode=true;
    if(out!="") return true;
  }
  h=FileOpen(path, FILE_READ|FILE_TXT|FILE_ANSI);
  if(h==INVALID_HANDLE) return false;
  while(!FileIsEnding(h))
  {
    string line=FileReadString(h);
    out += line;
    if(!FileIsEnding(h)) out += "\n";
  }
  FileClose(h);
  is_unicode=false;
  return out!="";
}

bool WriteFileText(const string path, const string txt, const bool unicode)
{
  int flags = FILE_WRITE|FILE_TXT|(unicode?FILE_UNICODE:FILE_ANSI);
  int h=FileOpen(path, flags);
  if(h==INVALID_HANDLE) return false;
  FileWriteString(h, txt);
  FileClose(h);
  return true;
}

string StripExpertBlock(const string tpl)
{
  int s=StringFind(tpl, "<expert>");
  if(s<0) return tpl;
  int e=StringFind(tpl, "</expert>", s);
  if(e<0) return tpl;
  e += StringLen("</expert>");
  return StringSubstr(tpl, 0, s) + StringSubstr(tpl, e);
}

string NormalizeExpertPath(string expert)
{
  string e=expert;
  StringReplace(e, "/", "\\");
  // if absolute path contains MQL5\\Experts\\, keep only relative part
  string lower=e; StringToLower(lower);
  string marker="\\mql5\\experts\\";
  int idx=StringFind(lower, marker);
  if(idx>=0)
    e=StringSubstr(e, idx+StringLen(marker));
  if(StringFind(e, "Experts\\")==0) e=StringSubstr(e, StringLen("Experts\\"));
  if(StringLen(e)>4)
  {
    string tail=StringSubstr(e, StringLen(e)-4);
    if(tail==".ex5" || tail==".mq5") e=StringSubstr(e,0,StringLen(e)-4);
  }
  return e;
}

string NormalizeIndicatorPath(string name)
{
  string e=name;
  if(StringFind(e, "wpath ")==0) e=StringSubstr(e, 6);
  StringReplace(e, "\"", "");
  StringReplace(e, "/", "\\");
  string lower=e; StringToLower(lower);
  string marker="\\mql5\\indicators\\";
  int idx=StringFind(lower, marker);
  if(idx>=0)
    e=StringSubstr(e, idx+StringLen(marker));
  if(StringFind(e, "Indicators\\")==0) e=StringSubstr(e, StringLen("Indicators\\"));
  if(StringLen(e)>4)
  {
    string tail=StringSubstr(e, StringLen(e)-4);
    if(tail==".ex5" || tail==".mq5") e=StringSubstr(e,0,StringLen(e)-4);
  }
  return e;
}

string ResolveIndicatorPath(const string name)
{
  string e=NormalizeIndicatorPath(name);
  string base="MQL5\\Indicators\\";
  if(FileIsExist(base+e+".ex5") || FileIsExist(base+e+".mq5")) return e;
  string alt="Examples\\"+e+"\\"+e;
  if(FileIsExist(base+alt+".ex5") || FileIsExist(base+alt+".mq5")) return alt;
  return e;
}

string ResolveExpertPath(const string expert)
{
  string e=NormalizeExpertPath(expert);
  string base="MQL5\\Experts\\";
  if(FileIsExist(base+e+".ex5") || FileIsExist(base+e+".mq5")) return e;
  string alt="Examples\\"+e+"\\"+e;
  if(FileIsExist(base+alt+".ex5") || FileIsExist(base+alt+".mq5")) return alt;
  return e;
}

string BuildExpertBlock(const string name, const string pstr)
{
  string block="<expert>\n";
  block+="name="+name+"\n";
  block+="flags=343\n";
  block+="window_num=0\n";
  block+="<inputs>\n";
  if(pstr!="")
  {
    string tmp=pstr;
    string keys[], vals[]; int cnt=ParseParams(tmp, keys, vals);
    for(int i=0;i<cnt;i++)
    {
      if(keys[i]=="") continue;
      block+=keys[i]+"="+vals[i]+"\n";
    }
  }
  block+="</inputs>\n";
  block+="</expert>\n";
  return block;
}

bool TemplateHasExpert(const string txt, const string expected)
{
  string lower=txt; StringToLower(lower);
  string exp=expected; StringToLower(exp);
  int s=StringFind(lower, "<expert>");
  if(s<0) return false;
  int e=StringFind(lower, "</expert>", s);
  if(e<0) return false;
  string block=StringSubstr(lower, s, e-s);
  if(StringFind(block, "name="+exp)>=0) return true;
  return false;
}

bool ChartHasExpert(const long cid, const string expected)
{
  string tmpName="__cmdmt_check.tpl";
  if(!ChartSaveTemplate(cid, tmpName)) return false;
  string path=TemplatesAbs()+"\\"+tmpName+".tpl";
  string txt=""; bool is_unicode=false;
  if(!ReadFileText(path, txt, is_unicode)) { FileDelete(path); return false; }
  bool ok=TemplateHasExpert(txt, expected);
  FileDelete(path);
  return ok;
}

string CurrentLogDate()
{
  MqlDateTime dt; TimeToStruct(TimeCurrent(), dt);
  return StringFormat("%04d%02d%02d", dt.year, dt.mon, dt.day);
}

string LogPath()
{
  return "MQL5\\Logs\\"+CurrentLogDate()+".log";
}

void LogCaptureBegin()
{
  string curDate=CurrentLogDate();
  g_log_date=curDate;
  string path=LogPath();
  int h=FileOpen(path, FILE_READ|FILE_TXT|FILE_UNICODE);
  if(h==INVALID_HANDLE) h=FileOpen(path, FILE_READ|FILE_TXT|FILE_ANSI);
  if(h==INVALID_HANDLE) { g_log_pos=0; return; }
  g_log_pos=(long)FileSize(h);
  FileClose(h);
}

bool ReadLogLines(string &out[])
{
  ArrayResize(out,0);
  string curDate=CurrentLogDate();
  if(g_log_date!=curDate) { g_log_date=curDate; g_log_pos=0; }
  string path=LogPath();
  int h=FileOpen(path, FILE_READ|FILE_TXT|FILE_UNICODE);
  bool unicode=true;
  if(h==INVALID_HANDLE)
  {
    h=FileOpen(path, FILE_READ|FILE_TXT|FILE_ANSI);
    unicode=false;
  }
  if(h==INVALID_HANDLE) return false;
  long size=(long)FileSize(h);
  if(g_log_pos<0 || g_log_pos>size) g_log_pos=0;
  FileSeek(h, (int)g_log_pos, SEEK_SET);
  while(!FileIsEnding(h))
  {
    string line=FileReadString(h);
    if(line!="")
    {
      int n=ArraySize(out);
      ArrayResize(out, n+1); out[n]=line;
    }
  }
  g_log_pos=(long)FileTell(h);
  FileClose(h);
  return true;
}

string FindLogError(const string filter)
{
  string lines[];
  if(!ReadLogLines(lines)) return "";
  string f=filter; StringToLower(f);
  for(int i=ArraySize(lines)-1;i>=0;i--)
  {
    string l=lines[i]; StringToLower(l);
    if(f!="" && StringFind(l, f)<0) continue;
    if(StringFind(l, "cannot load")>=0 || StringFind(l, "init failed")>=0 || StringFind(l, "failed")>=0 || StringFind(l, "error")>=0)
      return lines[i];
  }
  return "";
}

ENUM_OBJECT ObjectTypeFromString(string t)
{
  StringToUpper(t);
  if(t=="OBJ_TREND") return OBJ_TREND;
  if(t=="OBJ_HLINE") return OBJ_HLINE;
  if(t=="OBJ_VLINE") return OBJ_VLINE;
  if(t=="OBJ_RECTANGLE") return OBJ_RECTANGLE;
  if(t=="OBJ_TEXT") return OBJ_TEXT;
  if(t=="OBJ_LABEL") return OBJ_LABEL;
  if(t=="OBJ_ARROW") return OBJ_ARROW;
  if(t=="OBJ_TRIANGLE") return OBJ_TRIANGLE;
  if(t=="OBJ_ELLIPSE") return OBJ_ELLIPSE;
  if(t=="OBJ_CHANNEL") return OBJ_CHANNEL;
  return OBJ_TREND;
}

// ---------------- Handlers ----------------------
bool H_Ping(string &p[], string &m, string &d[]) { m="pong "+LISTENER_VERSION; return true; }
bool H_Debug(string &p[], string &m, string &d[]) { if(ArraySize(p)>0) Print(p[0]); m="printed"; return true; }

bool H_GlobalSet(string &p[], string &m, string &d[])
{
  if(ArraySize(p)<2){ m="params"; return false; }
  string name=p[0]; double val=StringToDouble(p[1]);
  bool ok = GlobalVariableSet(name, val) > 0;
  m = ok?"set":"fail"; return ok;
}
bool H_GlobalGet(string &p[], string &m, string &d[])
{
  if(ArraySize(p)<1){ m="params"; return false; }
  string name=p[0];
  if(!GlobalVariableCheck(name)){ m="not_found"; return false; }
  double v = GlobalVariableGet(name);
  ArrayResize(d,1); d[0]=DoubleToString(v,8);
  m="ok"; return true;
}
bool H_GlobalDel(string &p[], string &m, string &d[])
{
  if(ArraySize(p)<1){ m="params"; return false; }
  m = GlobalVariableDel(p[0]) ? "deleted" : "not_found";
  return (m=="deleted");
}
bool H_GlobalDelPrefix(string &p[], string &m, string &d[])
{
  if(ArraySize(p)<1){ m="params"; return false; }
  string prefix=p[0];
  int total=GlobalVariablesTotal();
  int removed=0;
  for(int i=0;i<total;i++)
  {
    string nm=GlobalVariableName(i);
    if(StringFind(nm, prefix)==0)
    {
      if(GlobalVariableDel(nm)) removed++;
    }
  }
  m=StringFormat("removed=%d", removed); return true;
}
bool H_GlobalList(string &p[], string &m, string &d[])
{
  string prefix = (ArraySize(p)>0)?p[0]:"";
  int limit = (ArraySize(p)>1)?(int)StringToInteger(p[1]):0;
  int total=GlobalVariablesTotal();
  int count=0;
  for(int i=0;i<total;i++)
  {
    string nm=GlobalVariableName(i);
    if(prefix!="" && StringFind(nm,prefix)!=0) continue;
    double v=GlobalVariableGet(nm);
    ArrayResize(d,ArraySize(d)+1); d[ArraySize(d)-1]=nm+"="+DoubleToString(v,8);
    count++;
    if(limit>0 && count>=limit) break;
  }
  m=StringFormat("vars=%d", count); return true;
}

bool H_OpenChart(string &p[], string &m, string &d[])
{
  if(ArraySize(p)<2){ m="params"; return false; }
  string sym=p[0]; ENUM_TIMEFRAMES tf=TfFromString(p[1]);
  if(tf==0){ m="tf"; return false; }
  if(!EnsureSymbol(sym))
  {
    string tfstr=p[1];
    if(UseChartDefaults(sym, tfstr))
    {
      tf = TfFromString(tfstr);
      if(tf==0){ m="tf"; return false; }
    }
    else { m="symbol"; return false; }
  }
  long cid=ChartOpen(sym, tf);
  if(cid==0){ m="ChartOpen fail"; return false; }
  ChartSetInteger(cid, CHART_BRING_TO_TOP, 0, true);
  ArrayResize(d,1); d[0]=IntegerToString((long)cid);
  m="opened"; return true;
}

bool H_ApplyTpl(string &p[], string &m, string &d[])
{
  if(ArraySize(p)<3){ m="params"; return false; }
  string sym=p[0]; ENUM_TIMEFRAMES tf=TfFromString(p[1]); string tpl=p[2];
  long cid=FindChartBySymbolTf(sym, tf);
  if(cid==0) cid=ChartOpen(sym, tf);
  if(cid==0){ m="ChartOpen"; return false; }
  if(!ChartApplyTemplate(cid, tpl)) { m="apply fail"; return false; }
  Sleep(200);
  m="template applied"; return true;
}

bool H_SaveTpl(string &p[], string &m, string &d[])
{
  if(ArraySize(p)<3){ m="params"; return false; }
  string sym=p[0]; ENUM_TIMEFRAMES tf=TfFromString(p[1]); string tpl=p[2];
  long cid=FindChartBySymbolTf(sym, tf);
  if(cid==0) cid=ChartOpen(sym, tf);
  if(cid==0){ m="ChartOpen"; return false; }
  if(!ChartSaveTemplate(cid, tpl)) { m="save fail"; return false; }
  m="template saved"; return true;
}

// Cria um template com EA a partir de um base template (sem anexar no chart)
// params: [0]=EA name, [1]=OUT_TPL, [2]=BASE_TPL (opcional), [3]=params (k=v;...)
bool H_SaveTplEA(string &p[], string &m, string &d[])
{
  if(ArraySize(p)<2){ m="params"; return false; }
  string expert=p[0];
  string outTpl=p[1];
  string baseTpl = (ArraySize(p)>2 && p[2]!="") ? p[2] : "";
  string pstr = (ArraySize(p)>3)?p[3]:"";

  string epath=ResolveExpertPath(expert);
  if(baseTpl=="")
  {
    string prefer="Moving Average.tpl";
    if(FileIsExist(TemplatesAbs()+"\\"+prefer)) baseTpl=prefer;
    else if(FileIsExist(TemplatesAbs()+"\\Default.tpl")) baseTpl="Default.tpl";
    else if(FileIsExist(TemplatesAbs()+"\\default.tpl")) baseTpl="default.tpl";
    else baseTpl=expert+".tpl";
  }
  string basePath = baseTpl;
  if(StringFind(baseTpl, ":\\")<0 && StringFind(baseTpl, "\\\\")!=0 && StringFind(baseTpl, "/")<0)
    basePath = TemplatesAbs()+"\\"+baseTpl;
  string txt=""; bool is_unicode=false;
  if(!ReadFileText(basePath, txt, is_unicode)) { m="base_tpl"; return false; }
  txt=StripExpertBlock(txt);
  string block=BuildExpertBlock(epath, pstr);
  int pos=StringFind(txt, "</chart>");
  if(pos>=0) txt = StringSubstr(txt,0,pos) + block + StringSubstr(txt,pos);
  else       txt = txt + "\n" + block;

  // ensure .tpl extension
  if(StringLen(outTpl)>4)
  {
    string tail=StringSubstr(outTpl, StringLen(outTpl)-4);
    if(StringCompare(tail, ".tpl", false)!=0)
      outTpl += ".tpl";
  }
  else
  {
    outTpl += ".tpl";
  }
  string outPath = TemplatesAbs()+"\\"+outTpl;
  if(!WriteFileText(outPath, txt, is_unicode)) { m="tpl_write_fail"; return false; }
  m="tpl_saved"; return true;
}

// Salva template a partir de um chart específico (id) usando ChartSaveTemplate
// params: [0]=chart_id, [1]=name (sem .tpl)
bool H_ChartSaveTpl(string &p[], string &m, string &d[])
{
  if(ArraySize(p)<2){ m="params"; return false; }
  long cid=(long)StringToInteger(p[0]);
  string name=p[1];
  // ChartSaveTemplate adiciona .tpl automaticamente
  if(StringLen(name)>4)
  {
    string tail=StringSubstr(name, StringLen(name)-4);
    if(StringCompare(tail, ".tpl", false)==0)
      name=StringSubstr(name,0,StringLen(name)-4);
  }
  if(cid<=0){ m="chart_id"; return false; }
  bool ok=ChartSaveTemplate(cid, name);
  m= ok?"saved":"save fail"; return ok;
}

bool H_CloseChart(string &p[], string &m, string &d[])
{
  if(ArraySize(p)<2){ m="params"; return false; }
  string sym=p[0]; ENUM_TIMEFRAMES tf=TfFromString(p[1]);
  long id=ChartFirst(); int closed=0;
  while(id>=0)
  {
    long next=ChartNext(id);
    if(ChartSymbol(id)==sym && ChartPeriod(id)==tf)
    {
      ChartClose(id); closed++;
    }
    id=next;
  }
  m=StringFormat("closed=%d", closed); return true;
}

bool H_CloseAll(string &p[], string &m, string &d[])
{
  long id=ChartFirst(); int closed=0;
  while(id>=0)
  {
    long next=ChartNext(id);
    ChartClose(id); closed++;
    id=next;
  }
  m=StringFormat("closed=%d", closed); return true;
}

bool H_ListCharts(string &p[], string &m, string &d[])
{
  long id=ChartFirst(); int count=0;
  while(id>=0)
  {
    string sym=(string)ChartSymbol(id);
    ENUM_TIMEFRAMES tf=(ENUM_TIMEFRAMES)ChartPeriod(id);
    string line=StringFormat("%I64d|%s|%s", id, sym, EnumToString(tf));
    int n=ChartIndicatorsTotal(id,0);
    for(int i=0;i<n;i++) line+="|"+ChartIndicatorName(id,0,i);
    ArrayResize(d,ArraySize(d)+1); d[ArraySize(d)-1]=line;
    count++;
    id=ChartNext(id);
  }
  m=StringFormat("charts=%d", count); return true;
}

bool H_AttachInd(string &p[], string &m, string &d[])
{
  if(ArraySize(p)<4){ m="params"; return false; }
  string sym=p[0]; string tfstr=p[1]; string name=ResolveIndicatorPath(p[2]); int sub=SubwindowSafe(p[3]);
  string pstr="";
  if(ArraySize(p)>4)
  {
    if(ArraySize(p)==5) pstr=p[4];
    else
    {
      string extra[]; ArrayResize(extra, ArraySize(p)-4);
      for(int i=4;i<ArraySize(p);i++) extra[i-4]=p[i];
      pstr=Join(extra, ";");
    }
  }
  ENUM_TIMEFRAMES tf=TfFromString(tfstr); if(tf==0){ m="tf"; return false; }
  if(!EnsureSymbol(sym))
  {
    if(UseChartDefaults(sym, tfstr))
    {
      tf=TfFromString(tfstr); if(tf==0){ m="tf"; return false; }
    }
    else { m="symbol"; return false; }
  }
  long cid=FindChartBySymbolTf(sym, tf);
  if(cid==0) cid=ChartOpen(sym, tf);
  if(cid==0){ m="ChartOpen"; return false; }
  int handle=INVALID_HANDLE;
  if(pstr=="")
  {
    ResetLastError();
    handle=iCustom(sym, tf, name);
  }
  else
  {
    MqlParam inputs[]; BuildParams(pstr, inputs);
    int n=ArraySize(inputs);
    MqlParam all[];
    ArrayResize(all, n+1);
    all[0].type=TYPE_STRING; all[0].string_value=name;
    for(int i=0;i<n;i++) all[i+1]=inputs[i];
    ResetLastError();
    handle=IndicatorCreate(sym, tf, IND_CUSTOM, ArraySize(all), all);
  }
  if(handle==INVALID_HANDLE){
    return FailLast(m, "iCustom", name);
  }
  ResetLastError();
  if(!ChartIndicatorAdd(cid, sub-1, handle)){
    return FailLast(m, "ChartIndicatorAdd", name);
  }
  // tenta descobrir o nome real do indicador no chart
  string chartName="";
  int total=ChartIndicatorsTotal(cid, sub-1);
  for(int i=0;i<total;i++)
  {
    string nm=ChartIndicatorName(cid, sub-1, i);
    long hh=ChartIndicatorGet(cid, sub-1, nm);
    if((int)hh==handle){ chartName=nm; break; }
  }
  g_lastIndName=name; g_lastIndParams=pstr; g_lastIndSymbol=sym; g_lastIndTf=tfstr; g_lastIndSub=sub;
  g_lastIndHandle=handle; g_lastIndChartName=chartName;
  m="indicator attached"; return true;
}

bool H_DetachInd(string &p[], string &m, string &d[])
{
  if(ArraySize(p)<4){ m="params"; return false; }
  string sym=p[0]; string tfstr=p[1]; string name=p[2]; int sub=SubwindowSafe(p[3]);
  ENUM_TIMEFRAMES tf=TfFromString(tfstr); if(tf==0){ m="tf"; return false; }
  if(!EnsureSymbol(sym))
  {
    if(UseChartDefaults(sym, tfstr))
    {
      tf=TfFromString(tfstr); if(tf==0){ m="tf"; return false; }
    }
    else { m="symbol"; return false; }
  }
  long cid=FindChartBySymbolTf(sym, tf);
  if(cid==0) cid=ChartOpen(sym, tf);
  if(cid==0){ m="ChartOpen"; return false; }
  int total=ChartIndicatorsTotal(cid, sub-1);
  int deleted=0;
  for(int i=total-1;i>=0;i--)
  {
    string iname=ChartIndicatorName(cid, sub-1, i);
    if(StringCompare(iname, name)==0 || StringFind(iname, name)==0)
    {
      if(ChartIndicatorDelete(cid, sub-1, iname)) deleted++;
    }
  }
  m="detached="+IntegerToString((long)deleted);
  return (deleted>0);
}

bool H_DetachIndIndex(string &p[], string &m, string &d[])
{
  if(ArraySize(p)<4){ m="params"; return false; }
  string sym=p[0]; string tfstr=p[1]; int sub=SubwindowSafe(p[2]); int idx=(int)StringToInteger(p[3]);
  ENUM_TIMEFRAMES tf=TfFromString(tfstr); if(tf==0){ m="tf"; return false; }
  if(!EnsureSymbol(sym))
  {
    if(UseChartDefaults(sym, tfstr))
    {
      tf=TfFromString(tfstr); if(tf==0){ m="tf"; return false; }
    }
    else { m="symbol"; return false; }
  }
  long cid=FindChartBySymbolTf(sym, tf);
  if(cid==0) cid=ChartOpen(sym, tf);
  if(cid==0){ m="ChartOpen"; return false; }
  string name=ChartIndicatorName(cid, sub-1, idx);
  if(name==""){ m="not_found"; return false; }
  if(ChartIndicatorDelete(cid, sub-1, name))
  {
    m="detached=1";
    return true;
  }
  return FailLast(m, "ChartIndicatorDelete", name);
}

bool H_IndTotal(string &p[], string &m, string &d[])
{
  if(ArraySize(p)<3){ m="params"; return false; }
  string sym=p[0]; ENUM_TIMEFRAMES tf=TfFromString(p[1]); int sub=SubwindowSafe(p[2]);
  long cid=FindChartBySymbolTf(sym, tf);
  if(cid==0) cid=ChartOpen(sym, tf);
  if(cid==0){ m="ChartOpen"; return false; }
  int total=ChartIndicatorsTotal(cid, sub-1);
  ArrayResize(d,1); d[0]=IntegerToString(total);
  m="ok"; return true;
}

bool H_IndName(string &p[], string &m, string &d[])
{
  if(ArraySize(p)<4){ m="params"; return false; }
  string sym=p[0]; ENUM_TIMEFRAMES tf=TfFromString(p[1]); int sub=SubwindowSafe(p[2]); int idx=(int)StringToInteger(p[3]);
  long cid=FindChartBySymbolTf(sym, tf);
  if(cid==0) cid=ChartOpen(sym, tf);
  if(cid==0){ m="ChartOpen"; return false; }
  string nm=ChartIndicatorName(cid, sub-1, idx);
  ArrayResize(d,1); d[0]=nm; m="ok"; return true;
}

bool H_IndHandle(string &p[], string &m, string &d[])
{
  if(ArraySize(p)<4){ m="params"; return false; }
  string sym=p[0]; ENUM_TIMEFRAMES tf=TfFromString(p[1]); int sub=SubwindowSafe(p[2]); string name=p[3];
  long cid=FindChartBySymbolTf(sym, tf);
  if(cid==0) cid=ChartOpen(sym, tf);
  if(cid==0){ m="ChartOpen"; return false; }
  long h=ChartIndicatorGet(cid, sub-1, name);
  ArrayResize(d,1); d[0]=IntegerToString((long)h);
  m=(h!=INVALID_HANDLE)?"ok":"not_found";
  return true;
}

// Retorna buffers do indicador (valores e tempos) para Data Window
// params: [0]=symbol, [1]=tf, [2]=sub, [3]=name, [4]=count (opcional)
bool H_IndSnapshot(string &p[], string &m, string &d[])
{
  if(ArraySize(p)<4){ m="params"; return false; }
  string sym=p[0]; string tfstr=p[1]; int sub=SubwindowSafe(p[2]); string name=p[3];
  int count = (ArraySize(p)>4)? (int)StringToInteger(p[4]) : 5;
  if(count<1) count=1;
  if(count>200) count=200;
  ENUM_TIMEFRAMES tf=TfFromString(tfstr); if(tf==0){ m="tf"; return false; }
  if(!EnsureSymbol(sym))
  {
    if(UseChartDefaults(sym, tfstr))
    {
      tf=TfFromString(tfstr); if(tf==0){ m="tf"; return false; }
    }
    else { m="symbol"; return false; }
  }
  long cid=FindChartBySymbolTf(sym, tf);
  if(cid==0) cid=ChartOpen(sym, tf);
  if(cid==0){ m="ChartOpen"; return false; }
  int h=(int)ChartIndicatorGet(cid, sub-1, name);
  if(h==INVALID_HANDLE || h==0){
    if(g_lastIndChartName!="" && g_lastIndSymbol==sym && g_lastIndTf==tfstr && g_lastIndSub==sub){
      h=(int)ChartIndicatorGet(cid, sub-1, g_lastIndChartName);
    }
  }
  if(h==INVALID_HANDLE || h==0){
    // tenta achar pelo nome "curto"
    string base=name;
    int p=StringFind(base, "\\", StringLen(base)-1);
    if(p>=0) base=StringSubstr(base, p+1);
    if(StringLen(base)>4){
      string tail=StringSubstr(base, StringLen(base)-4);
      if(tail==".mq5" || tail==".ex5") base=StringSubstr(base,0,StringLen(base)-4);
    }
    string basel=base; StringToLower(basel);
    int total=ChartIndicatorsTotal(cid, sub-1);
    for(int i=0;i<total;i++)
    {
      string nm=ChartIndicatorName(cid, sub-1, i);
      string nml=nm; StringToLower(nml);
      if(StringFind(nml, basel)>=0)
      {
        h=(int)ChartIndicatorGet(cid, sub-1, nm);
        if(h!=INVALID_HANDLE && h!=0){ g_lastIndChartName=nm; break; }
      }
    }
  }
  if((h==INVALID_HANDLE || h==0) && g_lastIndHandle!=INVALID_HANDLE && g_lastIndSymbol==sym && g_lastIndTf==tfstr && g_lastIndSub==sub){
    h=g_lastIndHandle;
  }
  if(h==INVALID_HANDLE || h==0){ m="handle"; return false; }

  // Tenta inferir quantidade de buffers lendo os primeiros indices (nao existe INDICATOR_BUFFERS no MQL5)
  int buffers=0;
  int max_buffers=32;
  for(int i=0;i<max_buffers;i++)
  {
    double tmp[]; ResetLastError();
    int got=CopyBuffer(h, i, 0, 1, tmp);
    if(got>0){ buffers=i+1; continue; }
    if(i==0){ buffers=1; }
    break;
  }
  if(buffers<=0){ m="buffers"; return false; }

  datetime times[]; int copied=CopyTime(sym, tf, 0, count, times);
  int bars=Bars(sym, tf);

  ArrayResize(d,0);
  ArrayResize(d,ArraySize(d)+1); d[ArraySize(d)-1]="bars="+IntegerToString(bars);
  ArrayResize(d,ArraySize(d)+1); d[ArraySize(d)-1]="count="+IntegerToString(copied);
  if(copied>0){
    ArrayResize(d,ArraySize(d)+1); d[ArraySize(d)-1]="time0="+TimeToString(times[0], TIME_DATE|TIME_MINUTES|TIME_SECONDS);
    ArrayResize(d,ArraySize(d)+1); d[ArraySize(d)-1]="timeN="+TimeToString(times[copied-1], TIME_DATE|TIME_MINUTES|TIME_SECONDS);
  }
  ArrayResize(d,ArraySize(d)+1); d[ArraySize(d)-1]="buffers="+IntegerToString(buffers);

  for(int i=0;i<buffers;i++)
  {
    double vals[]; int got=CopyBuffer(h, i, 0, count, vals);
    string line="buf"+IntegerToString(i)+"=";
    if(got<=0){ line+="ERR"; }
    else
    {
      for(int j=0;j<got;j++)
      {
        if(j>0) line+=",";
        line+=DoubleToString(vals[j], 8);
      }
    }
    ArrayResize(d,ArraySize(d)+1); d[ArraySize(d)-1]=line;
  }
  m="ok"; return true;
}

// Retorna info de barras/tempo
// params: [0]=symbol, [1]=tf, [2]=count (opcional)
bool H_BarInfo(string &p[], string &m, string &d[])
{
  if(ArraySize(p)<2){ m="params"; return false; }
  string sym=p[0]; string tfstr=p[1];
  int count = (ArraySize(p)>2)? (int)StringToInteger(p[2]) : 5;
  if(count<1) count=1;
  if(count>200) count=200;
  ENUM_TIMEFRAMES tf=TfFromString(tfstr); if(tf==0){ m="tf"; return false; }
  if(!EnsureSymbol(sym))
  {
    if(UseChartDefaults(sym, tfstr))
    {
      tf=TfFromString(tfstr); if(tf==0){ m="tf"; return false; }
    }
    else { m="symbol"; return false; }
  }
  datetime times[]; int copied=CopyTime(sym, tf, 0, count, times);
  int bars=Bars(sym, tf);
  ArrayResize(d,0);
  ArrayResize(d,ArraySize(d)+1); d[ArraySize(d)-1]="bars="+IntegerToString(bars);
  ArrayResize(d,ArraySize(d)+1); d[ArraySize(d)-1]="count="+IntegerToString(copied);
  if(copied>0){
    ArrayResize(d,ArraySize(d)+1); d[ArraySize(d)-1]="time0="+TimeToString(times[0], TIME_DATE|TIME_MINUTES|TIME_SECONDS);
    ArrayResize(d,ArraySize(d)+1); d[ArraySize(d)-1]="timeN="+TimeToString(times[copied-1], TIME_DATE|TIME_MINUTES|TIME_SECONDS);
  }
  m="ok"; return true;
}

// Libera um handle obtido via ChartIndicatorGet/indhandle
bool H_IndRelease(string &p[], string &m, string &d[])
{
  if(ArraySize(p)<1){ m="params"; return false; }
  long h=(long)StringToInteger(p[0]);
  if(h==0 || h==INVALID_HANDLE){ m="handle"; return false; }
  bool ok = IndicatorRelease((int)h);
  m = ok ? "released" : "release_fail";
  return ok;
}

bool H_AttachEA(string &p[], string &m, string &d[])
{
  if(ArraySize(p)<3){ m="params"; return false; }
  string sym=p[0]; ENUM_TIMEFRAMES tf=TfFromString(p[1]); string expert=p[2];
  string baseTpl = (ArraySize(p)>3 && p[3]!="") ? p[3] : "";
  string pstr = (ArraySize(p)>4)?p[4]:"";
  if(tf==0){ m="tf"; return false; }
  long cid=FindChartBySymbolTF(sym, tf);
  if(cid==0){ m="chart_not_found"; return false; }
  EnsureSymbol(sym);

  // aplica template direto somente se o usuário passar um .tpl explícito
  if(baseTpl=="" && pstr=="" && StringFind(expert, ".tpl")>0)
  {
    string tplName=EnsureTplExt(expert);
    if(!ChartApplyTemplate(cid, tplName)) { m="ChartApplyTemplate"; return false; }
    g_lastEAName=expert; g_lastEAParams=pstr; g_lastEASymbol=sym; g_lastEATf=p[1]; g_lastEATpl=tplName;
    m="ea attached"; return true;
  }

  m="tpl_required";
  return false;
}

// --- Extras herdados do listener ---
bool H_DetachAll(string &p[], string &m, string &d[])
{
  long cid=0;
  if(ArraySize(p)>=2)
  {
    string sym=p[0]; ENUM_TIMEFRAMES tf=TfFromString(p[1]);
    cid=ChartOpen(sym, tf); if(cid==0){ m="ChartOpen"; return false; }
  }
  else
  {
    cid=ChartID();
  }
  int totalWin = (int)ChartGetInteger(cid, CHART_WINDOWS_TOTAL);
  int removed=0;
  for(int sub=0; sub<totalWin; sub++)
  {
    int tot=ChartIndicatorsTotal(cid, sub);
    for(int i=tot-1;i>=0;i--)
    {
      string iname=ChartIndicatorName(cid, sub, i);
      if(iname!="" && ChartIndicatorDelete(cid, sub, iname)) removed++;
    }
  }
  m="detached_all="+IntegerToString((long)removed);
  return true;
}

bool H_RedrawChart(string &p[], string &m, string &d[])
{
  long cid=0;
  if(ArraySize(p)>=2)
  {
    string sym=p[0]; ENUM_TIMEFRAMES tf=TfFromString(p[1]);
    cid=ChartOpen(sym, tf); if(cid==0){ m="ChartOpen"; return false; }
  }
  else if(ArraySize(p)==1 && p[0]!="")
  {
    cid=(long)StringToInteger(p[0]);
  }
  else
  {
    cid=ChartID();
  }
  ChartRedraw(cid);
  m="redrawn"; return true;
}

bool H_WindowFind(string &p[], string &m, string &d[])
{
  if(ArraySize(p)<2){ m="params"; return false; }
  if(ArraySize(p)<3){ m="noop"; return true; }
  string sym=p[0]; ENUM_TIMEFRAMES tf=TfFromString(p[1]); string name=p[2];
  long cid=ChartOpen(sym, tf); if(cid==0){ m="ChartOpen"; return false; }
  int sub=ChartWindowFind(cid, name);
  ArrayResize(d,1); d[0]=IntegerToString(sub);
  m="ok"; return true;
}

bool H_ListInputs(string &p[], string &m, string &d[])
{
  string srcParams = (g_lastIndParams!="") ? g_lastIndParams : g_lastEAParams;
  if(srcParams=="") { m="none"; return true; }
  string kvs[]; int n=StringSplit(srcParams, ';', kvs);
  for(int i=0;i<n;i++)
  {
    if(kvs[i]=="") continue;
    ArrayResize(d,ArraySize(d)+1); d[ArraySize(d)-1]=kvs[i];
  }
  m=StringFormat("inputs=%d", ArraySize(d));
  return true;
}

bool H_SetInput(string &p[], string &m, string &d[])
{
  if(ArraySize(p)<2){ m="params"; return false; }
  string key=p[0]; string val=p[1];
  bool isInd = (g_lastIndParams!="");
  string paramsStr = isInd ? g_lastIndParams : g_lastEAParams;
  if(paramsStr==""){ m="no_context"; return false; }
  string out[]; int n=StringSplit(paramsStr,';',out);
  bool found=false;
  for(int i=0;i<n;i++)
  {
    if(out[i]=="") continue;
    string kv[]; int c=StringSplit(out[i],'=',kv);
    if(c==2 && kv[0]==key){ out[i]=key+"="+val; found=true; break; }
  }
  if(!found)
  {
    ArrayResize(out,n+1); out[n]=key+"="+val; n++;
  }
  paramsStr = Join(out, ";");
  if(isInd)
  {
    g_lastIndParams=paramsStr;
    string paramsNew[]; ArrayResize(paramsNew,5); // sym tf name sub params
    paramsNew[0]=g_lastIndSymbol; paramsNew[1]=g_lastIndTf; paramsNew[2]=g_lastIndName; paramsNew[3]=IntegerToString(g_lastIndSub); paramsNew[4]=paramsStr;
    return H_AttachInd(paramsNew, m, d);
  }
  else
  {
    g_lastEAParams=paramsStr;
    string paramsNew[]; ArrayResize(paramsNew,5);
    paramsNew[0]=g_lastEASymbol; paramsNew[1]=g_lastEATf; paramsNew[2]=g_lastEAName; paramsNew[3]=""; paramsNew[4]=paramsStr;
    return H_AttachEA(paramsNew, m, d);
  }
}

bool H_SnapshotSave(string &p[], string &m, string &d[])
{
  if(ArraySize(p)<1){ m="params"; return false; }
  string name=p[0];
  if(!EnsureSnapshotFolder()){ m="folder_fail"; return false; }
  string rel="snapshots\\"+name+".tpl";
  string tpl=SnapshotFolderRel()+"\\"+name+".tpl";
  long cid=ChartID();
  bool ok=ChartSaveTemplate(cid, rel);
  if(!ok) ok=ChartSaveTemplate(cid, tpl);
  m= ok?"saved":"save fail"; return ok;
}

bool H_SnapshotApply(string &p[], string &m, string &d[])
{
  if(ArraySize(p)<1){ m="params"; return false; }
  string name=p[0];
  string rel="snapshots\\"+name+".tpl";
  string tpl=SnapshotFolderRel()+"\\"+name+".tpl";
  if(!FileIsExist(tpl)){ m="not found"; return false; }
  bool ok=ChartApplyTemplate(ChartID(), rel);
  if(!ok) ok=ChartApplyTemplate(ChartID(), tpl);
  m= ok?"applied":"apply fail"; return ok;
}

bool H_SnapshotList(string &p[], string &m, string &d[])
{
  string folder=SnapshotFolderRel();
  if(!FileIsExist(folder)){ m="empty"; return true; }
  string path; long h=FileFindFirst(folder+"\\*.tpl", path);
  if(h==INVALID_HANDLE){ m="empty"; return true; }
  int c=0;
  while(true)
  {
    string base=StringSubstr(path, StringLen(folder)+2);
    ArrayResize(d,ArraySize(d)+1); d[ArraySize(d)-1]=base;
    c++;
    if(!FileFindNext(h, path)) break;
  }
  FileFindClose(h);
  m=StringFormat("snapshots=%d", c); return true;
}

bool H_ObjList(string &p[], string &m, string &d[])
{
  string prefix = (ArraySize(p)>0)?p[0]:"";
  int total=ObjectsTotal(0,0,-1);
  for(int i=0;i<total;i++)
  {
    string nm=ObjectName(0,i,0,-1);
    if(prefix!="" && StringFind(nm,prefix)!=0) continue;
    ArrayResize(d,ArraySize(d)+1); d[ArraySize(d)-1]=nm;
  }
  m=StringFormat("objs=%d", ArraySize(d)); return true;
}

bool H_ObjDelete(string &p[], string &m, string &d[])
{
  if(ArraySize(p)<1){ m="params"; return false; }
  string name=p[0];
  bool ok=ObjectDelete(0,name);
  m= ok? "deleted":"not_found"; return ok;
}

bool H_ObjDeletePrefix(string &p[], string &m, string &d[])
{
  if(ArraySize(p)<1){ m="params"; return false; }
  string prefix=p[0]; int total=ObjectsTotal(0,0,-1); int del=0;
  for(int i=total-1;i>=0;i--)
  {
    string nm=ObjectName(0,i,0,-1);
    if(StringFind(nm,prefix)==0) if(ObjectDelete(0,nm)) del++;
  }
  m=StringFormat("deleted=%d", del); return (del>0);
}

bool H_ObjMove(string &p[], string &m, string &d[])
{
  if(ArraySize(p)<3){ m="params"; return false; }
  string name=p[0]; datetime t1=(datetime)StringToTime(p[1]); double p1=StringToDouble(p[2]);
  int idx = (ArraySize(p)>=4)? (int)StringToInteger(p[3]) : 0;
  bool ok=ObjectMove(0, name, idx, t1, p1);
  m = ok? "moved":"move_fail"; return ok;
}

bool H_ObjCreate(string &p[], string &m, string &d[])
{
  // Minimal create: type,name,time,price,time2,price2
  if(ArraySize(p)<6){ m="params"; return false; }
  string type=p[0]; string name=p[1];
  datetime t1=(datetime)StringToTime(p[2]); double p1=StringToDouble(p[3]);
  datetime t2=(datetime)StringToTime(p[4]); double p2=StringToDouble(p[5]);
  ENUM_OBJECT ot = (ENUM_OBJECT)ObjectTypeFromString(type);
  bool ok=ObjectCreate(0, name, ot, 0, t1, p1, t2, p2);
  m = ok? "created":"create_fail"; return ok;
}

bool H_Screenshot(string &p[], string &m, string &d[])
{
  string sym=""; string tfstr=""; string name="";
  if(ArraySize(p)>=2){ sym=p[0]; tfstr=p[1]; }
  if(ArraySize(p)>=3){ name=p[2]; }
  long cid=0;
  if(sym!="" && tfstr!="")
  {
    ENUM_TIMEFRAMES tf=TfFromString(tfstr); if(tf==0){ m="tf"; return false; }
    cid=ChartOpen(sym, tf); if(cid==0){ m="ChartOpen"; return false; }
  }
  else
  {
    cid=ChartID();
  }
  string base="MQL5\\Files\\cmdmt";
  FolderCreate(base);
  string folder=base+"\\screens";
  FolderCreate(folder);
  if(name=="")
  {
    string s = (sym!=""?sym:ChartSymbol(cid));
    string t = (tfstr!=""?tfstr:EnumToString((ENUM_TIMEFRAMES)ChartPeriod(cid)));
    name=StringFormat("cmdmt_%s_%s_%d.png", s, t, (int)TimeLocal());
  }
  if(StringFind(name, ".png")<0) name += ".png";
  string path=folder+"\\"+name;
  bool ok=ChartScreenShot(cid, path, 0, 0, ALIGN_RIGHT);
  if(!ok){ m="screenshot_fail"; return false; }
  ArrayResize(d,1); d[0]="file="+path;
  m="ok"; return true;
}

bool H_DropInfo(string &p[], string &m, string &d[])
{
  long cid=ChartID();
  string sym=ChartSymbol(cid);
  ENUM_TIMEFRAMES tf=(ENUM_TIMEFRAMES)ChartPeriod(cid);
  ArrayResize(d,1); d[0]=StringFormat("chart=%s %s", sym, EnumToString(tf));
  m="ok"; return true;
}

bool H_ScreenshotSweep(string &p[], string &m, string &d[])
{
  m="screenshot disabled";
  return true;
}

bool H_DetachEA(string &p[], string &m, string &d[])
{
  long cid=ChartID();
  bool removed=false;
  int total=ChartIndicatorsTotal(cid,0);
  for(int i=total-1;i>=0;i--)
  {
    string nm=ChartIndicatorName(cid,0,i);
    string nml=nm; StringToLower(nml);
    if(StringFind(nml, "experts\\")>=0)
    {
      if(ChartIndicatorDelete(cid,0,nm)) removed=true;
    }
  }
  if(removed){ m="ea detached"; return true; }
  if(FileIsExist("MQL5\\Profiles\\Templates\\Default.tpl"))
  {
    if(ChartApplyTemplate(cid, "Default.tpl")) { m="template default aplicado"; return true; }
  }
  m="ea detach not supported"; return false;
}

// Trade helpers
CTrade _trade;

bool H_TradeBuy(string &p[], string &m, string &d[])
{
  if(ArraySize(p)<2){ m="params"; return false; }
  string sym=p[0]; double lots=StringToDouble(p[1]);
  double sl=0,tp=0;
  if(ArraySize(p)>=3) sl=StringToDouble(p[2]);
  if(ArraySize(p)>=4) tp=StringToDouble(p[3]);
  _trade.SetAsyncMode(false);
  bool ok=_trade.Buy(lots, sym, 0, sl, tp);
  if(ok){ m="buy sent"; return true; }
  long rc = (long)_trade.ResultRetcode();
  m = ErrFmtCodeDesc("TRADE_BUY", rc, _trade.ResultRetcodeDescription());
  return false;
}

bool H_TradeSell(string &p[], string &m, string &d[])
{
  if(ArraySize(p)<2){ m="params"; return false; }
  string sym=p[0]; double lots=StringToDouble(p[1]);
  double sl=0,tp=0;
  if(ArraySize(p)>=3) sl=StringToDouble(p[2]);
  if(ArraySize(p)>=4) tp=StringToDouble(p[3]);
  _trade.SetAsyncMode(false);
  bool ok=_trade.Sell(lots, sym, 0, sl, tp);
  if(ok){ m="sell sent"; return true; }
  long rc = (long)_trade.ResultRetcode();
  m = ErrFmtCodeDesc("TRADE_SELL", rc, _trade.ResultRetcodeDescription());
  return false;
}

bool H_TradeCloseAll(string &p[], string &m, string &d[])
{
  int total=PositionsTotal(); int closed=0;
  for(int i=total-1;i>=0;i--)
  {
    ulong ticket=PositionGetTicket(i);
    if(ticket!=0)
    {
      string sym=PositionGetString(POSITION_SYMBOL);
      ENUM_POSITION_TYPE pt=(ENUM_POSITION_TYPE)PositionGetInteger(POSITION_TYPE);
      double lots=PositionGetDouble(POSITION_VOLUME);
      bool ok=false;
      if(pt==POSITION_TYPE_BUY) ok=_trade.PositionClose(ticket);
      else if(pt==POSITION_TYPE_SELL) ok=_trade.PositionClose(ticket);
      if(ok) closed++;
    }
  }
  m=StringFormat("closed=%d", closed); return (closed>0);
}

bool H_TradeList(string &p[], string &m, string &d[])
{
  int total=PositionsTotal();
  ArrayResize(d,0);
  for(int i=0;i<total;i++)
  {
    ulong ticket=PositionGetTicket(i);
    if(ticket==0) continue;
    // após PositionGetTicket, a posição fica selecionada
    string sym   = PositionGetString(POSITION_SYMBOL);
    ENUM_POSITION_TYPE pt = (ENUM_POSITION_TYPE)PositionGetInteger(POSITION_TYPE);
    double vol    = PositionGetDouble(POSITION_VOLUME);
    double price  = PositionGetDouble(POSITION_PRICE_OPEN);
    double sl     = PositionGetDouble(POSITION_SL);
    double tp     = PositionGetDouble(POSITION_TP);
    int idx = ArraySize(d);
    ArrayResize(d, idx+1);
    d[idx]=StringFormat("%I64u|%s|%d|%g|%g|%g|%g", ticket, sym, pt, vol, price, sl, tp);
  }
  m=StringFormat("positions=%d", ArraySize(d)); return true;
}

// Dispara ação de "script" (encapsulada em ScriptActions.mqh)
bool H_RunScript(string &p[], string &m, string &d[])
{
  return RunScriptAction(p, m, d);
}

bool Dispatch(string type, string &params[], string &msg, string &data[])
{
  bool ok=false;
  if(type=="PING") ok = H_Ping(params,msg,data);
  else if(type=="DEBUG_MSG") ok = H_Debug(params,msg,data);
  else if(type=="GLOBAL_SET") ok = H_GlobalSet(params,msg,data);
  else if(type=="GLOBAL_GET") ok = H_GlobalGet(params,msg,data);
  else if(type=="GLOBAL_DEL") ok = H_GlobalDel(params,msg,data);
  else if(type=="GLOBAL_DEL_PREFIX") ok = H_GlobalDelPrefix(params,msg,data);
  else if(type=="GLOBAL_LIST") ok = H_GlobalList(params,msg,data);
  else if(type=="DETACH_ALL") ok = H_DetachAll(params,msg,data);
  else if(type=="OPEN_CHART") ok = H_OpenChart(params,msg,data);
  else if(type=="REDRAW_CHART") ok = H_RedrawChart(params,msg,data);
  else if(type=="SCREENSHOT") ok = H_Screenshot(params,msg,data);
  else if(type=="SCREENSHOT_SWEEP") ok = H_ScreenshotSweep(params,msg,data);
  else if(type=="DROP_INFO") ok = H_DropInfo(params,msg,data);
  else if(type=="APPLY_TPL") ok = H_ApplyTpl(params,msg,data);
  else if(type=="SAVE_TPL") ok = H_SaveTpl(params,msg,data);
  else if(type=="SAVE_TPL_EA") ok = H_SaveTplEA(params,msg,data);
  else if(type=="CHART_SAVE_TPL") ok = H_ChartSaveTpl(params,msg,data);
  else if(type=="CLOSE_CHART") ok = H_CloseChart(params,msg,data);
  else if(type=="CLOSE_ALL") ok = H_CloseAll(params,msg,data);
  else if(type=="LIST_CHARTS") ok = H_ListCharts(params,msg,data);
  else if(type=="WINDOW_FIND") ok = H_WindowFind(params,msg,data);
  else if(type=="LIST_INPUTS") ok = H_ListInputs(params,msg,data);
  else if(type=="SET_INPUT") ok = H_SetInput(params,msg,data);
  else if(type=="SNAPSHOT_SAVE") ok = H_SnapshotSave(params,msg,data);
  else if(type=="SNAPSHOT_APPLY") ok = H_SnapshotApply(params,msg,data);
  else if(type=="SNAPSHOT_LIST") ok = H_SnapshotList(params,msg,data);
  else if(type=="ATTACH_IND_FULL") ok = H_AttachInd(params,msg,data);
  else if(type=="DETACH_IND_FULL") ok = H_DetachInd(params,msg,data);
  else if(type=="DETACH_IND_INDEX") ok = H_DetachIndIndex(params,msg,data);
  else if(type=="IND_TOTAL") ok = H_IndTotal(params,msg,data);
  else if(type=="IND_NAME") ok = H_IndName(params,msg,data);
  else if(type=="IND_HANDLE") ok = H_IndHandle(params,msg,data);
  else if(type=="IND_GET") ok = H_IndHandle(params,msg,data);
  else if(type=="IND_SNAPSHOT") ok = H_IndSnapshot(params,msg,data);
  else if(type=="BAR_INFO") ok = H_BarInfo(params,msg,data);
  else if(type=="IND_RELEASE") ok = H_IndRelease(params,msg,data);
  else if(type=="ATTACH_EA_FULL") ok = H_AttachEA(params,msg,data);
  else if(type=="DETACH_EA_FULL") ok = H_DetachEA(params,msg,data);
  else if(type=="RUN_SCRIPT") ok = H_RunScript(params,msg,data);
  else if(type=="TRADE_BUY") ok = H_TradeBuy(params,msg,data);
  else if(type=="TRADE_SELL") ok = H_TradeSell(params,msg,data);
  else if(type=="TRADE_CLOSE_ALL") ok = H_TradeCloseAll(params,msg,data);
  else if(type=="TRADE_LIST") ok = H_TradeList(params,msg,data);
  else if(type=="OBJ_LIST") ok = H_ObjList(params,msg,data);
  else if(type=="OBJ_DELETE") ok = H_ObjDelete(params,msg,data);
  else if(type=="OBJ_DELETE_PREFIX") ok = H_ObjDeletePrefix(params,msg,data);
  else if(type=="OBJ_MOVE") ok = H_ObjMove(params,msg,data);
  else if(type=="OBJ_CREATE") ok = H_ObjCreate(params,msg,data);
  else { msg="unknown"; ok=false; }

  if(ok)
  {
    string up=msg; StringToUpper(up);
    if(msg=="") msg="OK";
    else if(StringFind(up,"OK ")!=0) msg="OK "+msg;
    return true;
  }

  if(!ok)
  {
    string up=msg; StringToUpper(up);
    bool has_err = (StringFind(up,"ERR ")==0) || (StringFind(up,"ERR=")>=0) || (StringFind(up,"CODE=")>=0);
    if(!has_err)
    {
      int err = GetLastError();
      if(err!=0)
      {
        msg = "ERR " + msg + " code=" + IntegerToString(err) + " (" + Diag_ErrorText(err) + ")";
      }
      else
      {
        int sc=0; string sd="";
        if(SvcErrorLookup(msg, sc, sd))
          msg = "ERR " + msg + " code=" + IntegerToString(sc) + " (" + sd + ")";
        else
          msg = "ERR " + msg;
      }
      ResetLastError();
    }
  }
  return ok;
}

#endif
