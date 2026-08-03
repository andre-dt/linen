# Erros que o compilador ainda aceita

Programas mal formados que hoje compilam sem reclamar, porque não existe
typechecker. Cada um vira um `reject-*.lang` no dia em que passar a ser
pego.

Estão listados aqui em vez de escritos como testes porque um teste que
falha desde o primeiro dia acostuma todo mundo a ver vermelho — e a
suíte só vale enquanto verde significa são.

| erro | exemplo |
|---|---|
| chamar função que não existe | `assert(nope() == 1)` |
| ler nome nunca ligado | `assert(x == 1)` |
| argumentos demais | `f(1, 2)` para `fn f(a i32)` |
| argumentos de menos | `f(1)` para `fn f(a i32, b i32)` |
| tipo que não existe | `fn f(a Blob) i32` |
| função sem `return` mas com tipo de retorno | `fn f() i32` com corpo sem return |
| `return` vazio numa função que declara tipo | `fn f() i32` com `return` só |
| função declarada duas vezes | dois `fn f()` |
| binding declarado duas vezes no mesmo escopo | dois `let x` |
| `test` com nome repetido | dois `test "t"` |
| `assert` de algo que não é booleano | `assert(1 + 1)` |

Divisão por zero fica de fora de propósito: `1 / 0` é erro de execução,
não de tipo, e só tem resposta quando houver backend para executá-lo.
