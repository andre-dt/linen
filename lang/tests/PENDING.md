# Erros que o compilador ainda aceita

Programas mal formados que hoje compilam sem reclamar. Cada um vira um
`reject-*.lang` no dia em que passar a ser pego.

Estão listados aqui em vez de escritos como testes porque um teste que
falha desde o primeiro dia acostuma todo mundo a ver vermelho — e a
suíte só vale enquanto verde significa são.

## O que já é pego

**Resolução** (`syntax/resolve.rs`) — chamar função inexistente,
argumento a mais, a menos, repetido, fora de ordem, campo obrigatório
omitido.

**Tipos** (`syntax/check.rs`) — nome nunca ligado, tipo inexistente,
condição não-booleana em `if`/`while`/`throw`, aritmética sobre `bool`,
`and`/`or` sobre número, igualdade entre número e bool, retorno do tipo
errado, `return` vazio com tipo declarado, valor de função que não
retorna nada, argumento do tipo errado.

## O que falta

| erro | exemplo |
|---|---|
| função declarada duas vezes | dois `fn f()` |
| binding declarado duas vezes no mesmo escopo | dois `let x` |
| `test` com nome repetido | dois `test "t"` |
| função sem `return` mas com tipo de retorno | `fn f() i32` com corpo sem return |
| default de tipo errado | `fn f(a i32 = true)` |

Divisão por zero fica de fora de propósito: `1 / 0` é erro de execução,
não de tipo, e só tem resposta quando houver backend para executá-lo.
O mesmo vale para overflow no estreitamento de i64 para i32 — é uma
checagem de runtime, não de tipo.

## `#!` — o que o typechecker ainda não enxerga

**Nenhum arquivo.** A lista está vazia: tudo em `tests/` passa pelo
lexer, parser, resolução, tipos e backend, e roda.

`shape` e `array` saíram: `Type::Shape(i)` e `Type::Array(i)` indexam
tabelas do unit. No LLVM uma shape é **struct por valor** e um array
fixo é **array por valor** — sem ponteiro, sem alocação, porque o
tamanho está no tipo. Valor imutável não tem identidade, então não há o
que um ponteiro distinguisse.

Falta `List<T>`, que cresce e mora na arena — é a próxima peça, e é o
que um polígono de tamanho desconhecido precisa.

## Sem checagem de limites

`xs[5]` num array de 3 lê fora. É checagem de **runtime**, e ainda não
há para onde reportar uma — o mesmo lugar onde entra o overflow do
estreitamento de i64 para i32.
