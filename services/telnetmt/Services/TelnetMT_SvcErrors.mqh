//+------------------------------------------------------------------+
//| SvcErrors.mqh                                                    |
//| Service-level error codes (internal)                             |
//+------------------------------------------------------------------+
#ifndef __SVC_ERRORS_MQH__
#define __SVC_ERRORS_MQH__

// retorna true se reconhecer o erro e preencher code/desc
bool SvcErrorLookup(const string msg, int &code, string &desc)
{
   string m = msg; StringToLower(m);
   if(StringFind(m, "params")>=0) { code=90001; desc="Invalid parameters"; return true; }
   if(StringFind(m, "tf")>=0)     { code=90002; desc="Invalid timeframe"; return true; }
   if(StringFind(m, "symbol")>=0) { code=90003; desc="Invalid symbol"; return true; }
   if(StringFind(m, "chartapplytemplate")>=0)
      { code=90019; desc="Template apply failed"; return true; }
   if(StringFind(m, "chartopen")>=0 || StringFind(m, "chart open")>=0)
      { code=90004; desc="Chart open failed"; return true; }
   if(m=="chart")
      { code=90004; desc="Chart open failed"; return true; }
   if(StringFind(m, "chart_not_found")>=0)
      { code=90005; desc="Chart not found"; return true; }
   if(StringFind(m, "handle")>=0)
      { code=90006; desc="Invalid handle"; return true; }
   if(StringFind(m, "not_found")>=0 || StringFind(m, "not found")>=0)
      { code=90007; desc="Not found"; return true; }
   if(StringFind(m, "tpl_write")>=0)
      { code=90008; desc="Template write error"; return true; }
   if(m=="tpl")
      { code=90011; desc="Template error"; return true; }
   if(StringFind(m, "base_tpl")>=0)
      { code=90009; desc="Base template not found"; return true; }
   if(StringFind(m, "tpl_required")>=0)
      { code=90010; desc="Template required"; return true; }
   if(StringFind(m, "template")>=0 || StringFind(m, "tpl")>=0)
      { code=90011; desc="Template error"; return true; }
   if(StringFind(m, "snapshot")>=0 || StringFind(m, "folder_fail")>=0)
      { code=90012; desc="Snapshot folder error"; return true; }
   if(StringFind(m, "screenshot")>=0)
      { code=90013; desc="Screenshot error"; return true; }
   if(StringFind(m, "window")>=0)
      { code=90014; desc="Window not found"; return true; }
   if(StringFind(m, "no_context")>=0)
      { code=90015; desc="No context available"; return true; }
   if(StringFind(m, "empty")>=0 || StringFind(m, "none")>=0 || StringFind(m, "noop")>=0)
      { code=90016; desc="No data"; return true; }
   if(StringFind(m, "file")>=0)
      { code=90017; desc="File error"; return true; }
   if(StringFind(m, "stub_")>=0)
      { code=90018; desc="Stub template error"; return true; }
   if(StringFind(m, "apply fail")>=0)
      { code=90019; desc="Template apply failed"; return true; }
   if(StringFind(m, "save fail")>=0)
      { code=90020; desc="Template save failed"; return true; }
   if(StringFind(m, "chart_id")>=0)
      { code=90021; desc="Invalid chart id"; return true; }
   if(StringFind(m, "ea detach not supported")>=0)
      { code=90022; desc="EA detach not supported"; return true; }
   if(StringFind(m, "screenshot disabled")>=0)
      { code=90023; desc="Screenshot disabled"; return true; }
   if(StringFind(m, "move_fail")>=0)
      { code=90024; desc="Object move failed"; return true; }
   if(StringFind(m, "create_fail")>=0)
      { code=90025; desc="Object create failed"; return true; }
   if(StringFind(m, "detach")>=0 && StringFind(m, "fail")>=0)
      { code=90026; desc="Detach failed"; return true; }
   if(StringFind(m, "attach")>=0 && StringFind(m, "fail")>=0)
      { code=90027; desc="Attach failed"; return true; }
   if(StringFind(m, "chartopen fail")>=0)
      { code=90028; desc="Chart open failed"; return true; }
   if(StringFind(m, "unknown")>=0)
      { code=90099; desc="Unknown command"; return true; }
   return false;
}

#endif // __SVC_ERRORS_MQH__
