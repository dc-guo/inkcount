import os
import sys
import streamlit.web.cli as stcli

def main():
    # Detect if we are running from a bundled PyInstaller executable
    if getattr(sys, 'frozen', False):
        # PyInstaller creates a temporary folder at sys._MEIPASS
        bundle_dir = sys._MEIPASS
    else:
        bundle_dir = os.path.dirname(os.path.abspath(__file__))
    
    # Path to our actual streamlit app code bundled alongside
    app_script_path = os.path.join(bundle_dir, "app.py")
    
    # Inject Streamlit execution arguments dynamically to masquerade as the command line
    # --server.headless disables any browser auto-run loops that crash PyInstaller bootloaders
    sys.argv = [
        "streamlit",
        "run",
        app_script_path,
        "--server.headless=false",
        "--global.developmentMode=false"
    ]
    
    # Execute Streamlit's CLI main directly, keeping it contained in the same process
    sys.exit(stcli.main())

if __name__ == "__main__":
    main()
