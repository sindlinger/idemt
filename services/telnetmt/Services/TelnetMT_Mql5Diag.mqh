//+------------------------------------------------------------------+
//| Mql5Diag.mqh                                                     |
//| Diagnostics helpers for errors and environment info              |
//+------------------------------------------------------------------+
#include "TelnetMT_Mql5Errors.mqh"
string Diag_ProgramTypeToStr(const long t)
{
   if(t==0) return "EXPERT";
   if(t==1) return "INDICATOR";
   if(t==2) return "SCRIPT";
   if(t==3) return "SERVICE";
   if(t==4) return "LIBRARY";
   return IntegerToString((int)t);
}

string Diag_ErrorText(const int err)
{
   return Mql5ErrorText(err);
}

int Diag_LogLastError(const string where, const bool reset_after=true, const bool log_zero=false)
{
   int err = GetLastError();
   if(err!=0 || log_zero)
      PrintFormat("[Diag] %s: err=%d (%s)", where, err, Diag_ErrorText(err));
   if(reset_after) ResetLastError();
   return err;
}

bool Diag_CheckStopped(const string where)
{
   if(IsStopped())
   {
      PrintFormat("[Diag] StopFlag set at %s", where);
      return true;
   }
   return false;
}

void Diag_PrintEnv()
{
   string os_ver  = TerminalInfoString(TERMINAL_OS_VERSION);
   string name    = TerminalInfoString(TERMINAL_NAME);
   string path    = TerminalInfoString(TERMINAL_PATH);
   string data    = TerminalInfoString(TERMINAL_DATA_PATH);
   string common  = TerminalInfoString(TERMINAL_COMMONDATA_PATH);
   long build     = TerminalInfoInteger(TERMINAL_BUILD);
   long connected = TerminalInfoInteger(TERMINAL_CONNECTED);

   string prog_name = MQLInfoString(MQL_PROGRAM_NAME);
   string prog_path = MQLInfoString(MQL_PROGRAM_PATH);
   long prog_type   = MQLInfoInteger(MQL_PROGRAM_TYPE);

   PrintFormat("[Diag] OS: %s | Terminal: %s | Build: %d | Connected: %d",
               os_ver, name, (int)build, (int)connected);
   PrintFormat("[Diag] Path: %s", path);
   PrintFormat("[Diag] Data: %s", data);
   PrintFormat("[Diag] Common: %s", common);
   PrintFormat("[Diag] Program: %s | %s | Type: %s",
               prog_name, prog_path, Diag_ProgramTypeToStr(prog_type));
}
