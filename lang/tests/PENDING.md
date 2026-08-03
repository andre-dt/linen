# Erros que o compilador ainda aceita

Programas mal formados que hoje compilam sem reclamar, porque não existe
typechecker. Cada um vira um `reject-*.lang` no dia em que passar a ser
pego.

Estão listados aqui em vez de escritos como testes porque um teste que
falha desde o primeiro dia acostuma todo mundo a ver vermelho — e a
suíte só vale enquanto verde significa são.

Já pegos pela resolução (`syntax/resolve.rs`), não estão mais na lista:
chamar função que não existe, argumento a mais, argumento a menos,
argumento repetido, argumento fora de ordem, campo obrigatório omitido.

| erro | exemplo |
|---|---|
| ler nome nunca ligado | `throw "m" if x == 1` |
| tipo que não existe | `fn f(a Blob) i32` |
| função sem `return` mas com tipo de retorno | `fn f() i32` com corpo sem return |
| `return` vazio numa função que declara tipo | `fn f() i32` com `return` só |
| função declarada duas vezes | dois `fn f()` |
| binding declarado duas vezes no mesmo escopo | dois `let x` |
| `test` com nome repetido | dois `test "t"` |
| `throw` de algo que não é booleano | `throw "m" if 1 + 1` |
| default de tipo errado | `fn f(a i32 = true)` |

Divisão por zero fica de fora de propósito: `1 / 0` é erro de execução,
não de tipo, e só tem resposta quando houver backend para executá-lo.
