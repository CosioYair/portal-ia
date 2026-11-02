"""Comprueba que un archivo es Python válido SIN ejecutarlo ni escribir nada (ast.parse). Uso: python check_python.py archivo.py"""
import ast
import sys

with open(sys.argv[1], encoding="utf-8") as fh:
    ast.parse(fh.read(), filename=sys.argv[1])
print("ok")
