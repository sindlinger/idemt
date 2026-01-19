// CsvImport.mqh
// Funcoes utilitarias para importar CSV de rates/ticks em simbolo customizado.

#ifndef __CSV_IMPORT_MQH__
#define __CSV_IMPORT_MQH__

string CsvTrim(string s)
{
  StringTrimLeft(s);
  StringTrimRight(s);
  return s;
}

int CsvDigitsFromPrice(string s)
{
  s = CsvTrim(s);
  int dot = StringFind(s, ".");
  if (dot < 0) return 0;
  return StringLen(s) - dot - 1;
}

ushort CsvDetectDelim(const string line)
{
  if (StringFind(line, "\t") >= 0) return (ushort)'\t';
  if (StringFind(line, ";") >= 0) return (ushort)';';
  return (ushort)',';
}

bool CsvParseBool(string s, bool defval)
{
  s = CsvTrim(s);
  StringToLower(s);
  if (s == "1" || s == "true" || s == "yes" || s == "y" || s == "on") return true;
  if (s == "0" || s == "false" || s == "no" || s == "n" || s == "off") return false;
  return defval;
}

int CsvParseInt(string s, int defval)
{
  s = CsvTrim(s);
  if (s == "") return defval;
  return (int)StringToInteger(s);
}

double CsvParseDouble(string s, double defval)
{
  s = CsvTrim(s);
  if (s == "") return defval;
  return StringToDouble(s);
}

bool CsvParseTimeWithMs(string s, datetime &t, int &ms)
{
  s = CsvTrim(s);
  ms = 0;
  int last = -1;
  int pos = StringFind(s, ".", 0);
  while (pos >= 0)
  {
    last = pos;
    pos = StringFind(s, ".", pos + 1);
  }
  if (last >= 0)
  {
    string tail = StringSubstr(s, last + 1);
    if (StringFind(tail, ":") < 0 && StringFind(tail, " ") < 0)
    {
      ms = (int)StringToInteger(tail);
      s = StringSubstr(s, 0, last);
    }
  }
  t = StringToTime(s);
  return (t > 0);
}

bool CsvEnsureSymbol(string symbol, string baseSymbol, int digits, int spread, string &msg)
{
  if (symbol == "")
  {
    msg = "symbol vazio";
    return false;
  }
  bool exists = SymbolInfoInteger(symbol, SYMBOL_SELECT) != 0;
  if (!exists)
  {
    bool created = false;
    if (baseSymbol != "" && SymbolInfoInteger(baseSymbol, SYMBOL_SELECT) != 0)
      created = CustomSymbolCreate(symbol, baseSymbol);
    else
      created = CustomSymbolCreate(symbol, NULL);
    if (!created)
    {
      msg = "CustomSymbolCreate falhou err=" + IntegerToString(GetLastError());
      return false;
    }
  }
  if (digits >= 0)
  {
    double point = MathPow(10.0, -digits);
    CustomSymbolSetInteger(symbol, SYMBOL_DIGITS, digits);
    CustomSymbolSetDouble(symbol, SYMBOL_POINT, point);
    CustomSymbolSetDouble(symbol, SYMBOL_TRADE_TICK_SIZE, point);
    CustomSymbolSetDouble(symbol, SYMBOL_TRADE_TICK_VALUE, point);
    CustomSymbolSetDouble(symbol, SYMBOL_TRADE_TICK_VALUE_PROFIT, point);
    CustomSymbolSetDouble(symbol, SYMBOL_TRADE_TICK_VALUE_LOSS, point);
  }
  if (spread > 0) CustomSymbolSetInteger(symbol, SYMBOL_SPREAD, spread);
  CustomSymbolSetInteger(symbol, SYMBOL_TRADE_MODE, SYMBOL_TRADE_MODE_FULL);
  SymbolSelect(symbol, true);
  return true;
}

bool CsvImportRates(string csvPath, string symbol, string tfStr, bool recreate, string baseSymbol, int digits,
                    int spread, int tzOffsetHours, bool useCommon, string sep, string &msg)
{
  if (recreate && SymbolInfoInteger(symbol, SYMBOL_SELECT) != 0) CustomSymbolDelete(symbol);

  int fileFlags = FILE_READ | FILE_TXT | FILE_ANSI | FILE_SHARE_READ;
  if (useCommon) fileFlags |= FILE_COMMON;
  int fh = FileOpen(csvPath, fileFlags);
  if (fh == INVALID_HANDLE)
  {
    msg = "FileOpen falhou: " + csvPath + " err=" + IntegerToString(GetLastError());
    return false;
  }

  string line = "";
  while (!FileIsEnding(fh))
  {
    line = FileReadString(fh);
    if (StringLen(line) > 0) break;
  }
  if (StringLen(line) == 0)
  {
    FileClose(fh);
    msg = "arquivo vazio";
    return false;
  }

  // remover BOM se existir
  if (StringLen(line) > 0 && StringGetCharacter(line, 0) == 0xFEFF) line = StringSubstr(line, 1);

  ushort delim = sep == "tab" ? (ushort)'\t' : sep == "comma" ? (ushort)',' : sep == "semicolon" ? (ushort)';' : CsvDetectDelim(line);

  // ler primeira linha de dados para detectar digitos
  string firstData = "";
  while (!FileIsEnding(fh))
  {
    firstData = FileReadString(fh);
    if (StringLen(firstData) > 0) break;
  }
  if (StringLen(firstData) == 0)
  {
    FileClose(fh);
    msg = "sem dados";
    return false;
  }

  string fields[];
  int n = StringSplit(firstData, delim, fields);
  if (n < 6)
  {
    FileClose(fh);
    msg = "linha invalida";
    return false;
  }
  if (digits < 0) digits = CsvDigitsFromPrice(fields[2]);

  if (!CsvEnsureSymbol(symbol, baseSymbol, digits, spread, msg))
  {
    FileClose(fh);
    return false;
  }

  MqlRates batch[];
  ArrayResize(batch, 0);
  int batchMax = 1000;
  long total = 0;

  // processar primeira linha
  int idx = 0;
  ArrayResize(batch, 1);
  datetime t = StringToTime(fields[0] + " " + fields[1]) + (tzOffsetHours * 3600);
  batch[0].time = t;
  batch[0].open = CsvParseDouble(fields[2], 0);
  batch[0].high = CsvParseDouble(fields[3], 0);
  batch[0].low = CsvParseDouble(fields[4], 0);
  batch[0].close = CsvParseDouble(fields[5], 0);
  batch[0].tick_volume = (long)CsvParseInt(n > 6 ? fields[6] : "0", 0);
  batch[0].real_volume = CsvParseDouble(n > 7 ? fields[7] : "0", 0);
  batch[0].spread = (int)CsvParseInt(n > 8 ? fields[8] : "0", spread);

  while (!FileIsEnding(fh))
  {
    line = FileReadString(fh);
    if (StringLen(line) == 0) continue;
    int c = StringSplit(line, delim, fields);
    if (c < 6) continue;
    idx = ArraySize(batch);
    ArrayResize(batch, idx + 1);
    datetime tt = StringToTime(fields[0] + " " + fields[1]) + (tzOffsetHours * 3600);
    batch[idx].time = tt;
    batch[idx].open = CsvParseDouble(fields[2], 0);
    batch[idx].high = CsvParseDouble(fields[3], 0);
    batch[idx].low = CsvParseDouble(fields[4], 0);
    batch[idx].close = CsvParseDouble(fields[5], 0);
    batch[idx].tick_volume = (long)CsvParseInt(c > 6 ? fields[6] : "0", 0);
    batch[idx].real_volume = CsvParseDouble(c > 7 ? fields[7] : "0", 0);
    batch[idx].spread = (int)CsvParseInt(c > 8 ? fields[8] : "0", spread);

    if (ArraySize(batch) >= batchMax)
    {
      int added = CustomRatesUpdate(symbol, batch);
      if (added <= 0)
      {
        FileClose(fh);
        msg = "CustomRatesUpdate falhou err=" + IntegerToString(GetLastError());
        return false;
      }
      total += added;
      ArrayResize(batch, 0);
    }
  }

  if (ArraySize(batch) > 0)
  {
    int added = CustomRatesUpdate(symbol, batch);
    if (added <= 0)
    {
      FileClose(fh);
      msg = "CustomRatesUpdate falhou err=" + IntegerToString(GetLastError());
      return false;
    }
    total += added;
  }

  FileClose(fh);
  msg = "rates_importados=" + IntegerToString((int)total) + " symbol=" + symbol + " tf=" + tfStr;
  return true;
}

bool CsvImportTicks(string csvPath, string symbol, bool recreate, string baseSymbol, int digits, int spread,
                    int tzOffsetHours, bool useCommon, string sep, string &msg)
{
  if (recreate && SymbolInfoInteger(symbol, SYMBOL_SELECT) != 0) CustomSymbolDelete(symbol);

  int fileFlags = FILE_READ | FILE_TXT | FILE_ANSI | FILE_SHARE_READ;
  if (useCommon) fileFlags |= FILE_COMMON;
  int fh = FileOpen(csvPath, fileFlags);
  if (fh == INVALID_HANDLE)
  {
    msg = "FileOpen falhou: " + csvPath + " err=" + IntegerToString(GetLastError());
    return false;
  }

  string line = "";
  while (!FileIsEnding(fh))
  {
    line = FileReadString(fh);
    if (StringLen(line) > 0) break;
  }
  if (StringLen(line) == 0)
  {
    FileClose(fh);
    msg = "arquivo vazio";
    return false;
  }

  ushort delim = sep == "tab" ? (ushort)'\t' : sep == "comma" ? (ushort)',' : sep == "semicolon" ? (ushort)';' : CsvDetectDelim(line);

  // primeira linha de dados
  string firstData = "";
  while (!FileIsEnding(fh))
  {
    firstData = FileReadString(fh);
    if (StringLen(firstData) > 0) break;
  }
  if (StringLen(firstData) == 0)
  {
    FileClose(fh);
    msg = "sem dados";
    return false;
  }

  string fields[];
  int n = StringSplit(firstData, delim, fields);
  if (n < 3)
  {
    FileClose(fh);
    msg = "linha invalida";
    return false;
  }
  if (digits < 0) digits = CsvDigitsFromPrice(fields[1]);

  if (!CsvEnsureSymbol(symbol, baseSymbol, digits, spread, msg))
  {
    FileClose(fh);
    return false;
  }

  MqlTick batch[];
  ArrayResize(batch, 0);
  int batchMax = 5000;
  long total = 0;

  // processar primeira linha
  int ms = 0;
  datetime t = 0;
  CsvParseTimeWithMs(fields[0], t, ms);
  t += (tzOffsetHours * 3600);
  ArrayResize(batch, 1);
  batch[0].time = t;
  batch[0].time_msc = (long)t * 1000 + ms;
  batch[0].bid = CsvParseDouble(fields[2], 0);
  batch[0].ask = CsvParseDouble(fields[1], 0);
  batch[0].volume = CsvParseDouble(n > 3 ? fields[3] : "0", 0);
  batch[0].volume_real = CsvParseDouble(n > 4 ? fields[4] : "0", 0);
  batch[0].flags = TICK_FLAG_BID | TICK_FLAG_ASK;

  while (!FileIsEnding(fh))
  {
    line = FileReadString(fh);
    if (StringLen(line) == 0) continue;
    int c = StringSplit(line, delim, fields);
    if (c < 3) continue;
    int idx = ArraySize(batch);
    ArrayResize(batch, idx + 1);
    int ms2 = 0;
    datetime tt = 0;
    CsvParseTimeWithMs(fields[0], tt, ms2);
    tt += (tzOffsetHours * 3600);
    batch[idx].time = tt;
    batch[idx].time_msc = (long)tt * 1000 + ms2;
    batch[idx].ask = CsvParseDouble(fields[1], 0);
    batch[idx].bid = CsvParseDouble(fields[2], 0);
    batch[idx].volume = CsvParseDouble(c > 3 ? fields[3] : "0", 0);
    batch[idx].volume_real = CsvParseDouble(c > 4 ? fields[4] : "0", 0);
    batch[idx].flags = TICK_FLAG_BID | TICK_FLAG_ASK;

    if (ArraySize(batch) >= batchMax)
    {
      int added = CustomTicksAdd(symbol, batch);
      if (added <= 0)
      {
        FileClose(fh);
        msg = "CustomTicksAdd falhou err=" + IntegerToString(GetLastError());
        return false;
      }
      total += added;
      ArrayResize(batch, 0);
    }
  }

  if (ArraySize(batch) > 0)
  {
    int added = CustomTicksAdd(symbol, batch);
    if (added <= 0)
    {
      FileClose(fh);
      msg = "CustomTicksAdd falhou err=" + IntegerToString(GetLastError());
      return false;
    }
    total += added;
  }

  FileClose(fh);
  msg = "ticks_importados=" + IntegerToString((int)total) + " symbol=" + symbol;
  return true;
}

#endif
