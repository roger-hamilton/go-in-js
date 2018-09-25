package main

import (
	"fmt"
	"os"
	"strconv"
)

func fib(n int) int {
	if n <= 2 {
		return 1
	}
	return fib(n-1) + fib(n-2)
}

func main() {
	var n int
	if len(os.Args) > 1 {
		n, _ = strconv.Atoi(os.Args[1])
	}
	if n == 0 {
		n = 10
	}

	fmt.Printf("fib(%d) = %d\n", n, fib(n))
}
