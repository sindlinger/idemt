// ScriptActions.mqh
// Funções que emulam o "script" a ser disparado pelo serviço.
// Preencha RunScriptAction com a lógica desejada.

#ifndef __SCRIPT_ACTIONS_MQH__
#define __SCRIPT_ACTIONS_MQH__

#include "CsvImport.mqh"

string ScriptParamGet(string &params[], string key, string defval)
{
  string k = key + "=";
  for (int i = 0; i < ArraySize(params); i++)
  {
    if (StringFind(params[i], k) == 0) return StringSubstr(params[i], StringLen(k));
  }
  return defval;
}

int ScriptParamInt(string &params[], string key, int defval)
{
  string v = ScriptParamGet(params, key, "");
  return v == "" ? defval : (int)StringToInteger(v);
}

bool ScriptParamBool(string &params[], string key, bool defval)
{
  string v = ScriptParamGet(params, key, "");
  return v == "" ? defval : CsvParseBool(v, defval);
}

// Ação padrão: abre um chart e aplica um template.
// params: [0]=symbol, [1]=timeframe (M1,M5,...), [2]=template path
// Retorna msg "applied" ou erro "params"/"tf"/"chart"/"tpl"
bool RunScriptAction(string &params[], string &msg, string &data[])
{
  if (ArraySize(params) >= 1)
  {
    string cmd = params[0];
    StringToUpper(cmd);
    if (cmd == "IMPORT_RATES" || cmd == "IMPORT_TICKS")
    {
      string symbol = ScriptParamGet(params, "symbol", "");
      string csv = ScriptParamGet(params, "csv", "");
      string tfstr = ScriptParamGet(params, "tf", "");
      string base = ScriptParamGet(params, "base", "");
      string sep = ScriptParamGet(params, "sep", "");
      int digits = ScriptParamInt(params, "digits", -1);
      int spread = ScriptParamInt(params, "spread", 0);
      int tz = ScriptParamInt(params, "tz", 0);
      bool recreate = ScriptParamBool(params, "recreate", true);
      bool useCommon = ScriptParamBool(params, "common", false);
      string localMsg = "";

      if (cmd == "IMPORT_RATES")
      {
        bool ok = CsvImportRates(csv, symbol, tfstr, recreate, base, digits, spread, tz, useCommon, sep, localMsg);
        msg = localMsg;
        return ok;
      }
      else
      {
        bool ok = CsvImportTicks(csv, symbol, recreate, base, digits, spread, tz, useCommon, sep, localMsg);
        msg = localMsg;
        return ok;
      }
    }
  }

  if(ArraySize(params)<3){ msg="params"; return false; }
  string sym=params[0]; string tfstr=params[1]; string tpl=params[2];
  ENUM_TIMEFRAMES tf;
  tf=PERIOD_CURRENT;
  // converter tf
  string u=tfstr; StringToUpper(u);
  if(u=="M1") tf=PERIOD_M1; else
  if(u=="M5") tf=PERIOD_M5; else
  if(u=="M15") tf=PERIOD_M15; else
  if(u=="M30") tf=PERIOD_M30; else
  if(u=="H1") tf=PERIOD_H1; else
  if(u=="H4") tf=PERIOD_H4; else
  if(u=="D1") tf=PERIOD_D1; else
  if(u=="W1") tf=PERIOD_W1; else
  if(u=="MN1") tf=PERIOD_MN1; else { msg="tf"; return false; }

  long cid=ChartOpen(sym, tf);
  if(cid==0){ msg="chart"; return false; }
  if(!ChartApplyTemplate(cid, tpl)){ msg="tpl"; return false; }
  msg="applied";
  return true;
}

#endif
// diagnostics
#include "TelnetMT_Mql5Diag.mqh"
