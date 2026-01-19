// ImportRatesCsv.mq5
#property script_show_inputs
#property strict

#include "..\\Services\\CsvImport.mqh"

input string InpCsvPath = "cmdmt-import/EURUSD_H1_200809101700_202510212200.csv";
input string InpSymbol = "EURUSD_H1_CSV";
input string InpTimeframe = "H1";
input string InpBaseSymbol = "EURUSD";
input int InpDigits = -1;        // -1 = auto
input int InpSpread = 0;
input int InpTzOffsetHours = 0;
input bool InpRecreate = true;
input bool InpUseCommon = false;
input string InpSeparator = "";  // auto|tab|comma|semicolon

void OnStart()
{
  string msg = "";
  bool ok = CsvImportRates(InpCsvPath, InpSymbol, InpTimeframe, InpRecreate, InpBaseSymbol, InpDigits,
                           InpSpread, InpTzOffsetHours, InpUseCommon, InpSeparator, msg);
  if (ok) Print("[ImportRatesCsv] OK ", msg);
  else Print("[ImportRatesCsv] ERRO ", msg);
}

