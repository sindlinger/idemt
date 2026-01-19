// ImportTicksCsv.mq5
#property script_show_inputs
#property strict

#include "..\\Services\\CsvImport.mqh"

input string InpCsvPath = "cmdmt-import/BTCUSD_Ticks_2024.01.01_2024.12.31.csv";
input string InpSymbol = "BTCUSD_TICKS_2024";
input string InpBaseSymbol = "";
input int InpDigits = -1;        // -1 = auto
input int InpSpread = 0;
input int InpTzOffsetHours = 0;
input bool InpRecreate = true;
input bool InpUseCommon = false;
input string InpSeparator = "";  // auto|tab|comma|semicolon

void OnStart()
{
  string msg = "";
  bool ok = CsvImportTicks(InpCsvPath, InpSymbol, InpRecreate, InpBaseSymbol, InpDigits, InpSpread,
                           InpTzOffsetHours, InpUseCommon, InpSeparator, msg);
  if (ok) Print("[ImportTicksCsv] OK ", msg);
  else Print("[ImportTicksCsv] ERRO ", msg);
}

