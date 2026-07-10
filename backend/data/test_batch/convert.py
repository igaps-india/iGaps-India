import pandas as pd
import os

excel_path = r'c:\Users\HP\OneDrive\Documents\iGaps\Full code\backend\data\test_batch\Company_data.xlsx'
csv_path = r'c:\Users\HP\OneDrive\Documents\iGaps\Full code\backend\data\test_batch\companies.csv'

try:
    df = pd.read_excel(excel_path)
    df.to_csv(csv_path, index=False)
    print(f"Successfully converted {excel_path} to {csv_path}")
except Exception as e:
    print(f"Error converting file: {e}")
