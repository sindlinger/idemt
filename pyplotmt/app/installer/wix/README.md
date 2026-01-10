# PyPlot-MT MSI (WiX)

Requisitos:
- WiX Toolset v3 (candle.exe/light.exe) ou v4 (wix.exe).

Build:
```powershell
cd installer\wix
.\build.ps1
```

Saída:
- `PyPlot-MT.msi`

Notas:
- O MSI instala em `C:\Program Files\PyPlot-MT`
- Atalho no Menu Iniciar: `PyPlot-MT`
- Atalho de AutoStart (Startup): `PyPlot-MT`
